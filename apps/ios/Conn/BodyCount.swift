import Foundation
import OSLog

/// Debug builds launched with `CONN_BODY_COUNTS=1` count view body evaluations and parses. Every
/// half second the totals are logged (subsystem `com.nckrtl.conn.ios`, category `bodycount`) and
/// appended, with the time, to `Library/Caches/bodycount.log` in the app's container.
enum BodyCount {
    #if DEBUG
    static let enabled = ProcessInfo.processInfo.environment["CONN_BODY_COUNTS"] != nil
    nonisolated(unsafe) private static var counts: [String: Int] = [:]
    nonisolated(unsafe) private static var started = false
    private static let lock = NSLock()
    private static let log = Logger(subsystem: "com.nckrtl.conn.ios", category: "bodycount")
    private static let file = URL.cachesDirectory.appending(path: "bodycount.log")
    #endif

    @inline(__always)
    static func tick(_ name: StaticString) {
        #if DEBUG
        guard enabled else { return }
        lock.lock()
        counts["\(name)", default: 0] += 1
        let start = !started
        started = true
        lock.unlock()
        if start {
            try? Data().write(to: file)
            schedule()
        }
        #endif
    }

    #if DEBUG
    private static func schedule() {
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.5) {
            lock.lock()
            let line = counts.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
            lock.unlock()
            log.info("counts \(line, privacy: .public)")
            if let handle = try? FileHandle(forWritingTo: file) {
                handle.seekToEndOfFile()
                handle.write(Data("\(Date().timeIntervalSince1970) counts \(line)\n".utf8))
                try? handle.close()
            }
            schedule()
        }
    }
    #endif
}
