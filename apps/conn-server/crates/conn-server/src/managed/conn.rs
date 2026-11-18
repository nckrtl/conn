//! The fence at the byte level: every managed connection's socket is a [`FencedIo`]. The
//! handlers a connection carries (an HTTP request, an RPC or media WebSocket) are attached to
//! it. Once any of them is fenced, the socket refuses every further write and read, so nothing
//! Hyper or the WebSocket still buffers can reach the peer, and the connection ends. While one
//! is paused, writes wait. A handler stays registered until its connection is gone: only then
//! can the target say no handler and no sendable byte of that edge remain.
//!
//! Every managed response carries `Connection: close`, so an HTTP connection carries one
//! request and ends with it.

use std::{
    io,
    net::SocketAddr,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};

use futures_core::future::BoxFuture;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use super::Handle;
use crate::session::GateState;

/// The handlers attached to one connection.
#[derive(Default)]
pub struct Slot {
    handles: Mutex<Vec<Arc<Handle>>>,
}

impl std::fmt::Debug for Slot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Slot").finish_non_exhaustive()
    }
}

impl Slot {
    /// Keeps `handle` registered for the life of the connection and fences the connection
    /// with it.
    pub fn attach(&self, handle: Arc<Handle>) {
        crate::lock(&self.handles).push(handle);
    }
}

/// What a managed handler learns about its connection: the TCP peer and its slot.
#[derive(Clone, Debug)]
pub struct Peer {
    pub addr: SocketAddr,
    pub slot: Arc<Slot>,
}

impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, Listener>> for Peer {
    fn connect_info(stream: axum::serve::IncomingStream<'_, Listener>) -> Self {
        stream.remote_addr().clone()
    }
}

/// The managed listener: plain TCP, each socket wrapped in a [`FencedIo`].
#[derive(Debug)]
pub struct Listener(pub tokio::net::TcpListener);

impl axum::serve::Listener for Listener {
    type Io = FencedIo;
    type Addr = Peer;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match self.0.accept().await {
                Ok((stream, addr)) => {
                    let _ = stream.set_nodelay(true);
                    let slot = Arc::new(Slot::default());
                    let io = FencedIo {
                        inner: stream,
                        slot: slot.clone(),
                        watched: Vec::new(),
                    };
                    return (io, Peer { addr, slot });
                }
                // As axum's own TCP listener: a failed accept (out of descriptors) waits a
                // moment and tries again.
                Err(_) => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        Ok(Peer {
            addr: self.0.local_addr()?,
            slot: Arc::new(Slot::default()),
        })
    }
}

struct Watched {
    handle: Arc<Handle>,
    closed: BoxFuture<'static, ()>,
    changed: BoxFuture<'static, ()>,
}

/// A TCP socket that honours the fence of every handler attached to it.
pub struct FencedIo {
    inner: tokio::net::TcpStream,
    slot: Arc<Slot>,
    watched: Vec<Watched>,
}

impl std::fmt::Debug for FencedIo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FencedIo")
            .field("handlers", &self.watched.len())
            .finish_non_exhaustive()
    }
}

fn fenced() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "managed access revoked")
}

impl FencedIo {
    /// `Ready(Ok)`: all attached handlers are open. `Ready(Err)`: one is fenced. `Pending`:
    /// one is paused; the task wakes at its next change or its fence.
    fn check(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        {
            let handles = crate::lock(&self.slot.handles);
            for handle in handles.iter().skip(self.watched.len()) {
                self.watched.push(Watched {
                    handle: handle.clone(),
                    closed: handle.closed(),
                    changed: handle.changed(),
                });
            }
        }
        let mut paused = false;
        for watched in &mut self.watched {
            if watched.closed.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Err(fenced()));
            }
            match watched.handle.state() {
                GateState::Closed => return Poll::Ready(Err(fenced())),
                GateState::Paused => {
                    paused = true;
                    while watched.changed.as_mut().poll(cx).is_ready() {
                        watched.changed = watched.handle.changed();
                    }
                }
                GateState::Open => {}
            }
        }
        if paused {
            Poll::Pending
        } else {
            Poll::Ready(Ok(()))
        }
    }

    /// Reads stop only at a fence; a pause holds output, not input.
    fn check_fence(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        match self.check(cx) {
            Poll::Ready(Err(error)) => Err(error),
            _ => Ok(()),
        }
    }
}

impl AsyncRead for FencedIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.check_fence(cx)?;
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for FencedIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.check(cx) {
            Poll::Ready(Ok(())) => Pin::new(&mut self.inner).poll_write(cx, buf),
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Pending => Poll::Pending,
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.check(cx) {
            Poll::Ready(Ok(())) => Pin::new(&mut self.inner).poll_flush(cx),
            other => other,
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        // A fenced socket is dropped, not shut down gracefully: no buffered byte follows.
        self.check_fence(cx)?;
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Serves `router` on `listener` with fenced sockets. Never returns while the listener
/// works.
pub async fn serve(listener: tokio::net::TcpListener, router: axum::Router) -> io::Result<()> {
    axum::serve(
        Listener(listener),
        router.into_make_service_with_connect_info::<Peer>(),
    )
    .await
}
