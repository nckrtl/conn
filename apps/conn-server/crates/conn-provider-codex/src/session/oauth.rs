//! Codex owns the OAuth listener and token exchange. Relay only the callback the same
//! native sign-in issued, and wait for its result on the shared app-server connection.
use super::*;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::watch,
};
use url::Url;

#[derive(Default)]
pub(crate) struct Logins(Mutex<HashMap<String, Login>>);

struct Login {
    session: String,
    thread: String,
    issued: tokio::time::Instant,
    callback: Option<(Url, String)>,
    result: watch::Sender<Option<bool>>,
}

impl Logins {
    pub(crate) fn finish(&self, server: &str, success: bool) {
        if let Some(login) = crate::lock(&self.0).get(server) {
            login.result.send_replace(Some(success));
        }
    }
    pub(crate) fn release(&self, session: &str) {
        crate::lock(&self.0).retain(|_, login| login.session != session);
    }
    pub(crate) fn clear(&self) {
        crate::lock(&self.0).clear();
    }
    fn forget(&self, server: &str, result: &watch::Receiver<Option<bool>>) {
        let mut logins = crate::lock(&self.0);
        if logins
            .get(server)
            .is_some_and(|s| result.same_channel(&s.result.subscribe()))
        {
            logins.remove(server);
        }
    }
}

async fn request(
    inner: &Inner,
    thread: &ProviderThread,
    method: &'static str,
    params: Value,
) -> ProviderResult<Value> {
    let mut response = inner.server.request(method, params.clone()).await;
    if matches!(&response, Err(CallError::Rpc(e)) if e.code == -32600 && e.message.starts_with("thread not found:"))
    {
        let native =
            native_thread_id(thread).ok_or_else(|| failed(method, "Missing native thread ID"))?;
        inner
            .resume(
                &native,
                thread.app_thread_id.as_deref(),
                inner.open_cwd.as_deref(),
                inner.open_model.as_deref(),
                true,
            )
            .await?;
        response = inner.server.request(method, params).await;
    }
    response.map_err(call_failed(method))
}

fn query(url: &Url, key: &str) -> Option<String> {
    let mut fields = url.query_pairs().filter(|(k, _)| k == key);
    let value = fields.next()?.1.into_owned();
    (!value.is_empty() && fields.next().is_none()).then_some(value)
}

pub(super) async fn start(
    inner: &Inner,
    thread: ProviderThread,
    server: String,
) -> ProviderResult<Option<String>> {
    let native = native_thread_id(&thread)
        .ok_or_else(|| failed("mcp_sign_in", "Missing native thread ID"))?;
    let status = request(
        inner,
        &thread,
        "mcpServerStatus/list",
        json!({"threadId":native,"serverName":server,"detail":"toolsAndAuthOnly"}),
    )
    .await;
    if status
        .ok()
        .as_ref()
        .and_then(|v| v["data"].as_array())
        .is_some_and(|data| {
            data.iter()
                .any(|v| v["name"] == server && v["runtimeStatus"] == "connected")
        })
    {
        return Ok(None);
    }
    let logins = &inner.server.logins;
    let (result, watch) = watch::channel(None);
    {
        let mut all = crate::lock(&logins.0);
        all.retain(|_, l| l.issued.elapsed() < Duration::from_secs(600));
        if all.get(&server).is_some_and(|l| {
            (l.session != inner.id || l.thread != native) && l.result.borrow().is_none()
        }) {
            return Err(failed(
                "mcp_sign_in",
                "A sign-in for this MCP server is already open on another thread.",
            ));
        }
        all.insert(
            server.clone(),
            Login {
                session: inner.id.clone(),
                thread: native.clone(),
                issued: tokio::time::Instant::now(),
                callback: None,
                result,
            },
        );
    }
    let opened = async {
        let response = request(
            inner,
            &thread,
            "mcpServer/oauth/login",
            json!({"name":server,"threadId":native}),
        )
        .await?;
        let url = response["authorizationUrl"]
            .as_str()
            .and_then(|s| Url::parse(s).ok())
            .filter(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some())
            .ok_or_else(|| {
                failed(
                    "mcp_sign_in",
                    "Codex returned an invalid authorization URL.",
                )
            })?;
        let callback = query(&url, "redirect_uri")
            .and_then(|s| Url::parse(&s).ok())
            .zip(query(&url, "state"));
        let mut all = crate::lock(&logins.0);
        let login = all
            .get_mut(&server)
            .filter(|s| watch.same_channel(&s.result.subscribe()))
            .ok_or_else(|| failed("mcp_sign_in", "The sign-in was replaced."))?;
        login.callback = callback;
        Ok(Some(url.to_string()))
    }
    .await;
    if opened.is_err() {
        logins.forget(&server, &watch);
    }
    opened
}

fn checked_callback(redirect: &Url, state: &str, pasted: &str) -> Option<Url> {
    let url = Url::parse(pasted).ok()?;
    (url.scheme() == "http"
        && url.origin() == redirect.origin()
        && url.path() == redirect.path()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        && query(&url, "state").as_deref() == Some(state)
        && (query(&url, "code").is_some() || query(&url, "error").is_some()))
    .then_some(url)
}

async fn relay(url: &Url) -> std::io::Result<()> {
    let port = url.port_or_known_default().unwrap_or(80);
    let v4 = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let v6 = IpAddr::V6(Ipv6Addr::LOCALHOST);
    let mut socket = match url.host_str() {
        Some("[::1]") => TcpStream::connect((v6, port)).await?,
        Some("localhost") => match TcpStream::connect((v4, port)).await {
            Ok(stream) => stream,
            Err(_) => TcpStream::connect((v6, port)).await?,
        },
        _ => TcpStream::connect((v4, port)).await?,
    };
    let target = &url[url::Position::BeforePath..url::Position::AfterQuery];
    let host = &url[url::Position::BeforeHost..url::Position::AfterPort];
    socket
        .write_all(
            format!("GET {target} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await?;
    let mut byte = [0u8; 1];
    socket.read_exact(&mut byte).await?;
    Ok(())
}

pub(super) async fn complete(
    inner: &Inner,
    thread: ProviderThread,
    server: String,
    pasted: String,
) -> ProviderResult<()> {
    let native = native_thread_id(&thread)
        .ok_or_else(|| failed("mcp_sign_in", "Missing native thread ID"))?;
    let logins = &inner.server.logins;
    let (mut result, callback) = {
        let all = crate::lock(&logins.0);
        let login = all
            .get(&server)
            .filter(|s| {
                s.session == inner.id
                    && s.thread == native
                    && s.issued.elapsed() < Duration::from_secs(600)
            })
            .ok_or_else(|| failed("mcp_sign_in", "Start the sign-in for this thread again."))?;
        (login.result.subscribe(), login.callback.clone())
    };
    let mut delivered = true;
    if result.borrow().is_none() {
        let url = callback
            .and_then(|(redirect, state)| checked_callback(&redirect, &state, &pasted))
            .ok_or_else(|| failed("mcp_sign_in", "That callback does not match this sign-in."))?;
        delivered = matches!(
            tokio::time::timeout(Duration::from_secs(10), relay(&url)).await,
            Ok(Ok(()))
        );
    }
    let done = tokio::time::timeout(
        Duration::from_secs(if delivered { 30 } else { 2 }),
        result.wait_for(|r| r.is_some()),
    )
    .await;
    let success = matches!(done, Ok(Ok(ref value)) if **value == Some(true));
    drop(done);
    logins.forget(&server, &result);
    if success {
        Ok(())
    } else {
        Err(failed(
            "mcp_sign_in",
            "Codex did not confirm sign-in. Start again.",
        ))
    }
}
