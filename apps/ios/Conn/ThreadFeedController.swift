import SwiftUI
import UIKit

/// One feed row: its id (the diffable item), the space above it, and its SwiftUI content.
struct FeedRow {
    let id: String
    let gap: CGFloat
    /// What the row draws from (`feedSignature`): it is measured and redrawn only when this changes.
    var signature: Int = 0
    let content: @MainActor () -> AnyView
}

enum FeedScrollTarget: Equatable {
    case end
    case item(String)
}

struct FeedScrollRequest: Equatable {
    let id = UUID()
    let target: FeedScrollTarget
}

/// What the feed tells the screen around it. Only the floating control reads `showsJump`, so a
/// change redraws that control and not the feed.
@MainActor @Observable
final class FeedChrome {
    var showsJump = false
    @ObservationIgnored var pinned = true
    /// Where the floating control's buttons are, in its host's coordinates.
    @ObservationIgnored var reportFloatingFrame: (CGRect) -> Void = { _ in }
}

/// Expansion state by row, outside the cells: a cell is reused for other rows, and a row that
/// scrolls away and back keeps how it was.
@MainActor @Observable
final class FeedExpansion {
    private var open: Set<String> = []
    /// A row's height changes with it: the feed measures the rows in view again.
    @ObservationIgnored var onToggle: () -> Void = {}
    func isOpen(_ key: String) -> Bool { open.contains(key) }
    func toggle(_ key: String) {
        if open.remove(key) == nil { open.insert(key) }
        onToggle()
    }
}

extension EnvironmentValues {
    @Entry var feedExpansion: FeedExpansion?
    /// The feed's width, so rows can size from it before any container is laid out.
    @Entry var feedWidth: CGFloat?
}

/// A user bubble's column: 90% of the feed's width less 32 pt, at the trailing edge. From the
/// feed's width when it has one, so off-screen measuring gets the same wrap as the cell.
struct UserBubbleWidth: ViewModifier {
    @Environment(\.feedWidth) private var feedWidth

    func body(content: Content) -> some View {
        if let feedWidth {
            content.frame(width: (feedWidth - 32) * 0.9, alignment: .trailing)
        } else {
            content.containerRelativeFrame(.horizontal, alignment: .trailing) { width, _ in (width - 32) * 0.9 }
        }
    }
}

/// The thread feed: a UICollectionView of SwiftUI rows, with the composer as its bottom bar.
struct ThreadFeedHost: UIViewControllerRepresentable {
    let threadId: String
    let rows: [FeedRow]
    /// Below the last row: the stack gap and end marker the SwiftUI feed had.
    let bottomPadding: CGFloat
    /// The agents or syncing capsule's row, which the end of the feed sits above.
    let capsuleInset: CGFloat
    /// Reading an older window: the jump button shows wherever the reader is.
    let forceJump: Bool
    let hasContent: Bool
    let scrollRequest: FeedScrollRequest?
    let chrome: FeedChrome
    let composer: AnyView
    let floating: AnyView
    let onReachTop: () -> Void

    func makeUIViewController(context: Context) -> ThreadFeedController {
        ThreadFeedController(chrome: chrome)
    }

    func updateUIViewController(_ controller: ThreadFeedController, context: Context) {
        controller.theme = context.environment.connTheme
        controller.onReachTop = onReachTop
        controller.forceJump = forceJump
        controller.hasContent = hasContent
        controller.reset(thread: threadId)
        controller.setBars(composer: composer, floating: floating, capsuleInset: capsuleInset)
        controller.update(rows: rows, bottomPadding: bottomPadding)
        controller.perform(scrollRequest)
    }
}

final class ThreadFeedController: UIViewController, UICollectionViewDelegate, UIGestureRecognizerDelegate {
    let chrome: FeedChrome
    private let expansion = FeedExpansion()
    private let layout = FeedLayout()
    private lazy var collectionView = FeedCollectionView(frame: .zero, collectionViewLayout: layout)
    private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
    private var rows: [String: FeedRow] = [:]
    private var order: [String] = []
    /// Each row's height at `measuredWidth`, for the signature it was measured with. Rows are
    /// measured off screen before they show, so scrolling never corrects a guessed height.
    private var measured: [String: (signature: Int, height: CGFloat)] = [:]
    private var measuredWidth: CGFloat = 0
    /// Lays rows out off screen at the feed's width, inside the window so it has its text size.
    private let sizer = UIHostingController(rootView: AnyView(EmptyView()))
    private var measuringScheduled = false
    private let composerHost = UIHostingController(rootView: AnyView(EmptyView()))
    private let floatingHost = UIHostingController(rootView: AnyView(EmptyView()))
    private let floatingContainer = PassthroughView()
    private let topEdge = UIView()
    private var capsuleInset: CGFloat = 0
    private var thread: String?
    private var lastRequest: UUID?
    /// An animated scroll the feed started (Jump, a settle at the end): the follow waits for it.
    private var programmatic = false
    /// A drag up near the top asks for older history once the scroll settles.
    private var reachTopArmed = false
    private var lastOffset: CGFloat = 0
    private let probe = ProcessInfo.processInfo.environment["CONN_FEED_PROBE"] != nil ? FeedProbeView() : nil

    var theme = ConnTheme.resolve(for: .dark)
    var onReachTop: () -> Void = {}
    var forceJump = false
    var hasContent = false

    /// Pinned to the end: growth keeps the end in view. A drag drops it at once; it comes back
    /// only when a scroll settles at the end.
    private var pinned = true {
        didSet { chrome.pinned = pinned }
    }

    init(chrome: FeedChrome) {
        self.chrome = chrome
        super.init(nibName: nil, bundle: nil)
        chrome.reportFloatingFrame = { [weak self] in self?.floatingContainer.interactiveFrame = $0 }
        expansion.onToggle = { [weak self] in self?.remeasureLiveRows() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        let cv = collectionView
        cv.translatesAutoresizingMaskIntoConstraints = false
        cv.backgroundColor = .clear
        cv.contentInsetAdjustmentBehavior = .never
        cv.automaticallyAdjustsScrollIndicatorInsets = false
        cv.alwaysBounceVertical = true
        cv.keyboardDismissMode = .interactive
        cv.showsHorizontalScrollIndicator = false
        cv.delegate = self
        cv.accessibilityIdentifier = "thread.feed"
        cv.topEdgeEffect.style = .soft
        cv.bottomEdgeEffect.style = .soft
        cv.followsEnd = { [unowned self] in self.followsEnd }
        cv.didLayout = { [unowned self] in self.updateChrome() }
        layout.followsEnd = { [unowned self] in self.followsEnd }
        layout.height = { [unowned self] id in self.measured[id]?.height }
        layout.selfSized = { [unowned self] id, height in
            if let entry = self.measured[id] { self.measured[id] = (entry.signature, height) }
        }
        view.addSubview(cv)

        addChild(sizer)
        sizer.view.isHidden = true
        sizer.view.isUserInteractionEnabled = false
        sizer.safeAreaRegions = []
        view.addSubview(sizer.view)
        sizer.didMove(toParent: self)

        let registration = UICollectionView.CellRegistration<FeedCell, String> { [unowned self] cell, _, id in
            self.configure(cell, id: id)
        }
        dataSource = UICollectionViewDiffableDataSource(collectionView: cv) { cv, indexPath, id in
            cv.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: id)
        }

        // A tap on the feed puts the keyboard away; links, cards and buttons still get the tap.
        let tap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        cv.addGestureRecognizer(tap)

        // iOS's soft edge under the navigation bar, as the SwiftUI feed had.
        topEdge.translatesAutoresizingMaskIntoConstraints = false
        topEdge.isUserInteractionEnabled = false
        view.addSubview(topEdge)
        let topInteraction = UIScrollEdgeElementContainerInteraction()
        topInteraction.scrollView = cv
        topInteraction.edge = .top
        topEdge.addInteraction(topInteraction)

        for host in [composerHost, floatingHost] {
            addChild(host)
            host.view.backgroundColor = .clear
            host.view.translatesAutoresizingMaskIntoConstraints = false
            // The bars sit above the keyboard and home indicator already.
            host.safeAreaRegions = []
        }
        composerHost.sizingOptions = .intrinsicContentSize
        view.addSubview(composerHost.view)
        let bottomInteraction = UIScrollEdgeElementContainerInteraction()
        bottomInteraction.scrollView = cv
        bottomInteraction.edge = .bottom
        composerHost.view.addInteraction(bottomInteraction)

        floatingContainer.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(floatingContainer)
        floatingContainer.addSubview(floatingHost.view)

        NSLayoutConstraint.activate([
            cv.topAnchor.constraint(equalTo: view.topAnchor),
            cv.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            cv.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            cv.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            topEdge.topAnchor.constraint(equalTo: view.topAnchor),
            topEdge.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            topEdge.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            topEdge.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            composerHost.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            composerHost.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            composerHost.view.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            floatingContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            floatingContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            floatingContainer.bottomAnchor.constraint(equalTo: composerHost.view.topAnchor),
            floatingContainer.heightAnchor.constraint(equalToConstant: 64),
            floatingHost.view.topAnchor.constraint(equalTo: floatingContainer.topAnchor),
            floatingHost.view.bottomAnchor.constraint(equalTo: floatingContainer.bottomAnchor),
            floatingHost.view.leadingAnchor.constraint(equalTo: floatingContainer.leadingAnchor),
            floatingHost.view.trailingAnchor.constraint(equalTo: floatingContainer.trailingAnchor),
        ])
        composerHost.didMove(toParent: self)
        floatingHost.didMove(toParent: self)

        if let probe {
            probe.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
            view.addSubview(probe)
        }
    }

    // MARK: - Updates from SwiftUI

    func reset(thread id: String) {
        guard thread != id else { return }
        let first = thread == nil
        thread = id
        guard !first else { return }
        pinned = true
        programmatic = false
        measured.removeAll()
        layout.invalidateLayout()
    }

    func setBars(composer: AnyView, floating: AnyView, capsuleInset: CGFloat) {
        let theme = theme
        composerHost.rootView = AnyView(composer.environment(\.connTheme, theme))
        floatingHost.rootView = AnyView(
            floating
                .environment(\.connTheme, theme)
        )
        if self.capsuleInset != capsuleInset {
            self.capsuleInset = capsuleInset
            view.setNeedsLayout()
        }
    }

    func update(rows newRows: [FeedRow], bottomPadding: CGFloat) {
        loadViewIfNeeded()
        var seen = Set<String>()
        let unique = newRows.filter { seen.insert($0.id).inserted }
        // Only rows whose content changed are redrawn; the others keep their cells as they are.
        let changed = Set(unique.filter { rows[$0.id]?.signature != $0.signature }.map(\.id))
        rows = Dictionary(unique.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let ids = unique.map(\.id)
        let items = unique.map { FeedLayout.Item(id: $0.id, gap: $0.gap) }
        let anchor = pinned ? nil : captureAnchor()
        let paddingChanged = layout.bottomPadding != bottomPadding
        layout.bottomPadding = bottomPadding

        let orderChanged = ids != order
        // The cells' ids under the old order, before it changes.
        let live = liveIds().filter { changed.contains($0) }
        order = ids
        let gapsChanged = layout.items != items
        layout.items = items
        // A changed row already in a cell (a streaming reply) keeps its height for now; its cell
        // reports the new one when it redraws, so the row is laid out once per update, not twice.
        for id in live {
            if let row = rows[id], let entry = measured[id] { measured[id] = (row.signature, entry.height) }
        }
        measureNow(changed: changed)
        if orderChanged {
            var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
            snapshot.appendSections([0])
            snapshot.appendItems(ids)
            snapshot.reconfigureItems(live)
            dataSource.apply(snapshot, animatingDifferences: false)
        } else {
            if gapsChanged || paddingChanged || !changed.isEmpty { layout.invalidateLayout() }
            if !live.isEmpty {
                var snapshot = dataSource.snapshot()
                snapshot.reconfigureItems(live)
                dataSource.apply(snapshot, animatingDifferences: false)
            }
        }
        if let anchor { restore(anchor) } else { collectionView.setNeedsLayout() }
        updateChrome()
        DispatchQueue.main.async { [weak self] in self?.prefetchIfNearTop() }
    }

    func perform(_ request: FeedScrollRequest?) {
        guard let request, request.id != lastRequest else { return }
        lastRequest = request.id
        switch request.target {
        case .end:
            scrollToEnd(animated: view.window != nil)
        case let .item(id):
            pinned = false
            stopAnimation()
            programmatic = false
            for _ in 0..<3 {
                collectionView.layoutIfNeeded()
                guard let index = order.firstIndex(of: id), index < layout.frames.count else { return }
                let target = clamp(layout.frames[index].minY - collectionView.adjustedContentInset.top - layout.topPadding)
                if abs(collectionView.contentOffset.y - target) < 0.5 { break }
                collectionView.contentOffset.y = target
            }
        }
    }

    // MARK: - Measuring

    private func content(_ row: FeedRow) -> some View {
        row.content()
            .environment(\.connTheme, theme)
            .environment(\.feedExpansion, expansion)
            .environment(\.feedWidth, measuredWidth > 0 ? measuredWidth : nil)
            // The row's natural height for the width, whatever height the cell proposes: under an
            // exact height, text chose fewer lines (a list item truncated) and left the row short
            // of what the sizer measured.
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxHeight: .infinity, alignment: .top)
    }

    /// The row's height at the feed's width, laid out by SwiftUI as its cell will lay it out.
    private func measure(_ row: FeedRow) -> CGFloat {
        sizer.rootView = AnyView(content(row))
        let size = sizer.sizeThatFits(in: CGSize(width: measuredWidth, height: .greatestFiniteMagnitude))
        let scale = view.window?.screen.scale ?? 3
        return (size.height * scale).rounded(.up) / scale
    }

    private func needsMeasure(_ id: String) -> Bool {
        guard let row = rows[id] else { return false }
        return measured[id]?.signature != row.signature
    }

    /// Measures, before the next layout, what the reader sees or is about to: changed rows in or
    /// near view, and the rows around the viewport (from the end when pinned). The rest follow in
    /// small batches (`measureMore`).
    private func measureNow(changed: Set<String>) {
        let width = collectionView.bounds.width
        guard width > 0 else { return }
        if width != measuredWidth {
            measuredWidth = width
            measured.removeAll()
        }
        let cv = collectionView
        let screen = max(cv.bounds.height, 400)
        var wanted = Set<String>()
        if pinned || layout.frames.isEmpty {
            var covered: CGFloat = 0
            for id in order.reversed() {
                wanted.insert(id)
                covered += measured[id]?.height ?? FeedLayout.estimate
                if covered > screen * 2 { break }
            }
        } else {
            let top = cv.contentOffset.y - screen
            let bottom = cv.contentOffset.y + cv.bounds.height + screen
            for (index, id) in order.enumerated() where index < layout.frames.count {
                let frame = layout.frames[index]
                if frame.maxY >= top && frame.minY <= bottom { wanted.insert(id) }
            }
        }
        for id in changed where wanted.contains(id) || measured[id] != nil { wanted.insert(id) }
        var deltaAbove: CGFloat = 0
        let readTop = cv.contentOffset.y + cv.adjustedContentInset.top
        for (index, id) in order.enumerated() where wanted.contains(id) && needsMeasure(id) {
            guard let row = rows[id] else { continue }
            let old = measured[id]?.height ?? FeedLayout.estimate
            let height = measure(row)
            measured[id] = (row.signature, height)
            if index < layout.frames.count, layout.frames[index].maxY <= readTop { deltaAbove += height - old }
        }
        if !pinned && deltaAbove != 0 {
            layout.invalidateLayout()
            cv.layoutIfNeeded()
            cv.contentOffset.y += deltaAbove
        }
        scheduleMeasuring()
    }

    private func scheduleMeasuring() {
        guard !measuringScheduled, order.contains(where: needsMeasure) else { return }
        measuringScheduled = true
        DispatchQueue.main.async { [weak self] in
            self?.measuringScheduled = false
            self?.measureMore()
        }
    }

    /// A few more rows per run-loop turn, nearest the reader first. A row above the reader moves
    /// the offset by its change, so nothing in view shifts.
    private func measureMore() {
        guard measuredWidth > 0 else { return }
        let cv = collectionView
        let readTop = cv.contentOffset.y + cv.adjustedContentInset.top
        let center = cv.contentOffset.y + cv.bounds.height / 2
        let pending = order.enumerated().filter { needsMeasure($0.element) }
        guard !pending.isEmpty else { return }
        let nearest = pending.sorted { a, b in
            let fa = a.offset < layout.frames.count ? abs(layout.frames[a.offset].midY - center) : .greatestFiniteMagnitude
            let fb = b.offset < layout.frames.count ? abs(layout.frames[b.offset].midY - center) : .greatestFiniteMagnitude
            return fa < fb
        }.prefix(8)
        var deltaAbove: CGFloat = 0
        for (index, id) in nearest {
            guard let row = rows[id] else { continue }
            let old = measured[id]?.height ?? FeedLayout.estimate
            let height = measure(row)
            measured[id] = (row.signature, height)
            if index < layout.frames.count, layout.frames[index].maxY <= readTop { deltaAbove += height - old }
        }
        layout.invalidateLayout()
        if !followsEnd && deltaAbove != 0 {
            cv.layoutIfNeeded()
            cv.contentOffset.y += deltaAbove
        } else {
            cv.setNeedsLayout()
        }
        scheduleMeasuring()
    }

    /// Expanding a row in view changes its height: measure the rows in view again, keeping the
    /// first one where it is on screen.
    private func remeasureLiveRows() {
        let anchor = pinned ? nil : captureAnchor()
        for id in liveIds() { measured[id] = nil }
        measureNow(changed: [])
        layout.invalidateLayout()
        if let anchor { restore(anchor) } else { collectionView.setNeedsLayout() }
    }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        if previous?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory {
            measured.removeAll()
            layout.invalidateLayout()
        }
    }

    // MARK: - Cells

    private func configure(_ cell: FeedCell, id: String) {
        guard let row = rows[id] else {
            cell.show(AnyView(EmptyView()))
            return
        }
        cell.show(AnyView(content(row).id(id)))
    }

    /// Rows whose cells exist now; only they need their content refreshed.
    private func liveIds() -> [String] {
        collectionView.indexPathsForVisibleItems.compactMap { $0.item < order.count ? order[$0.item] : nil }
    }

    // MARK: - Following the end

    private var followsEnd: Bool {
        let cv = collectionView
        return pinned && !programmatic && !cv.isTracking && !cv.isDragging && !cv.isDecelerating
    }

    private func clamp(_ y: CGFloat) -> CGFloat {
        min(max(y, -collectionView.adjustedContentInset.top), collectionView.maxOffsetY)
    }

    private struct Anchor {
        let id: String
        let screenY: CGFloat
    }

    /// The first row in view and where it sits on screen.
    private func captureAnchor() -> Anchor? {
        let cv = collectionView
        let top = cv.contentOffset.y + cv.adjustedContentInset.top
        guard let index = layout.firstIndex(endingBelow: top), index < order.count else { return nil }
        return Anchor(id: order[index], screenY: layout.frames[index].minY - cv.contentOffset.y)
    }

    /// Puts the anchored row back where it was, so changes above it never move what is read.
    private func restore(_ anchor: Anchor) {
        let cv = collectionView
        cv.layoutIfNeeded()
        guard let index = order.firstIndex(of: anchor.id), index < layout.frames.count else { return }
        let target = clamp(layout.frames[index].minY - anchor.screenY)
        if abs(target - cv.contentOffset.y) > 0.5 { cv.contentOffset.y = target }
    }

    private func scrollToEnd(animated: Bool) {
        let cv = collectionView
        pinned = true
        programmatic = true
        view.layoutIfNeeded()
        cv.layoutIfNeeded()
        let distance = cv.maxOffsetY - cv.contentOffset.y
        guard animated, distance > 0.5 else {
            programmatic = false
            cv.setNeedsLayout()
            cv.layoutIfNeeded()
            return
        }
        // From far up, start a screen above the end, so the rows between needn't be measured.
        if distance > cv.bounds.height * 1.5 {
            cv.contentOffset.y = cv.maxOffsetY - cv.bounds.height
            cv.layoutIfNeeded()
        }
        animateToEnd()
    }

    // MARK: - Animated scroll to the end

    private var link: CADisplayLink?
    private var animationStart: CFTimeInterval = 0
    private var animationDistance: CGFloat = 0

    /// Eases the distance to the end down to zero. It aims at the end as it is in each frame, so
    /// rows measured on the way (which move the offset and would cancel UIKit's animated
    /// `setContentOffset`) never leave it short.
    private func animateToEnd() {
        stopAnimation()
        let cv = collectionView
        animationDistance = cv.maxOffsetY - cv.contentOffset.y
        guard animationDistance > 0.5 else {
            finishAnimation()
            return
        }
        programmatic = true
        animationStart = CACurrentMediaTime()
        let link = CADisplayLink(target: DisplayLinkTarget(self), selector: #selector(DisplayLinkTarget.tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    fileprivate func animationFrame() {
        let progress = min(1, (CACurrentMediaTime() - animationStart) / 0.35)
        let eased = 1 - pow(1 - progress, 3)
        let cv = collectionView
        cv.contentOffset.y = cv.maxOffsetY - animationDistance * (1 - eased)
        if progress >= 1 { finishAnimation() }
    }

    private func finishAnimation() {
        stopAnimation()
        programmatic = false
        collectionView.setNeedsLayout()
        collectionView.layoutIfNeeded()
        updateChrome()
    }

    private func stopAnimation() {
        link?.invalidate()
        link = nil
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if link != nil { finishAnimation() }
    }

    private func settle() {
        let distance = collectionView.maxOffsetY - collectionView.contentOffset.y
        // Within 24 pt of the end counts as the end, as before.
        if distance <= 24 {
            pinned = true
            if distance > 0.5 { animateToEnd() }
        }
        if reachTopArmed {
            reachTopArmed = false
            onReachTop()
        }
    }

    private func updateChrome() {
        let cv = collectionView
        let distance = cv.maxOffsetY - cv.contentOffset.y
        // Shown once the reader is more than 100 pt above the end, hidden within it.
        let shows = hasContent && (forceJump || distance > 100)
        if chrome.showsJump != shows {
            // Explicit, so the jump circle's entrance and exit play.
            withAnimation(.smooth(duration: 0.35)) { chrome.showsJump = shows }
        }
        probe?.report(cv, pinned: pinned, distance: distance, layout: layout, order: order)
    }

    @objc private func dismissKeyboard() {
        view.window?.endEditing(true)
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let cv = collectionView
        let bottom = max(0, view.bounds.maxY - composerHost.view.frame.minY) + capsuleInset
        let inset = UIEdgeInsets(top: view.safeAreaInsets.top, left: 0, bottom: bottom, right: 0)
        if cv.contentInset != inset {
            layout.invalidateLayout()
            cv.contentInset = inset
            cv.verticalScrollIndicatorInsets = inset
            // Pinned: the inset change keeps the end in view (the keyboard, a growing composer).
            cv.setNeedsLayout()
            cv.layoutIfNeeded()
        }
    }

    // MARK: - UIScrollViewDelegate

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        pinned = false
        stopAnimation()
        programmatic = false
        lastOffset = scrollView.contentOffset.y
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        measureAhead()
        prefetchIfNearTop()
        let y = scrollView.contentOffset.y
        if scrollView.isDragging, y < lastOffset, y + scrollView.adjustedContentInset.top < 160 {
            reachTopArmed = true
        }
        lastOffset = y
    }

    /// Rows within a screen and a half above or below the reader are measured before they come
    /// into view; the change of those above moves the offset, so what is read stays put.
    private func measureAhead() {
        let cv = collectionView
        let screen = cv.bounds.height
        let top = cv.contentOffset.y - screen * 1.5
        let bottom = cv.contentOffset.y + screen * 2.5
        let readTop = cv.contentOffset.y + cv.adjustedContentInset.top
        var deltaAbove: CGFloat = 0
        var any = false
        for (index, id) in order.enumerated() where index < layout.frames.count {
            let frame = layout.frames[index]
            guard frame.maxY >= top && frame.minY <= bottom, needsMeasure(id), let row = rows[id] else { continue }
            let old = measured[id]?.height ?? FeedLayout.estimate
            let height = measure(row)
            measured[id] = (row.signature, height)
            if frame.maxY <= readTop { deltaAbove += height - old }
            any = true
        }
        guard any else { return }
        layout.invalidateLayout()
        if !followsEnd && deltaAbove != 0 {
            cv.layoutIfNeeded()
            cv.contentOffset.y += deltaAbove
        }
    }

    /// Older history loads well before the reader reaches the oldest row: within two and a half
    /// screens of the top, and right after opening until about three screens are loaded. The
    /// screen around it ignores the call while a page is on its way or none is left.
    private func prefetchIfNearTop() {
        let cv = collectionView
        guard hasContent, !order.isEmpty, cv.bounds.height > 0 else { return }
        let fromTop = cv.contentOffset.y + cv.adjustedContentInset.top
        if fromTop < cv.bounds.height * 2.5 { onReachTop() }
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { settle() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        settle()
    }

    func scrollViewDidScrollToTop(_ scrollView: UIScrollView) {
        pinned = false
    }

    func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool {
        pinned = false
        return true
    }
}

/// Holds the controller weakly, so the display link doesn't keep it alive.
@MainActor
private final class DisplayLinkTarget: NSObject {
    weak var controller: ThreadFeedController?
    init(_ controller: ThreadFeedController) { self.controller = controller }
    @objc func tick() { controller?.animationFrame() }
}

/// The feed's scroll view: after each layout pass it keeps the end in view while pinned, and
/// reports the pass so the jump button follows the distance to the end.
final class FeedCollectionView: UICollectionView {
    var followsEnd: () -> Bool = { false }
    var didLayout: () -> Void = {}

    var maxOffsetY: CGFloat {
        max(-adjustedContentInset.top, contentSize.height + adjustedContentInset.bottom - bounds.height)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Rows measured on the way in change the content height; a few passes settle it.
        var passes = 0
        while followsEnd(), abs(contentOffset.y - maxOffsetY) > 0.5, passes < 4 {
            contentOffset.y = maxOffsetY
            super.layoutSubviews()
            passes += 1
        }
        didLayout()
    }
}

/// A plain stack of full-width rows. Heights are measured by the cells and kept by row id; when a
/// row above the reader changes height, the offset moves with it, so what is read stays put.
final class FeedLayout: UICollectionViewLayout {
    struct Item: Equatable {
        let id: String
        let gap: CGFloat
    }

    var items: [Item] = []
    let topPadding: CGFloat = 12
    var bottomPadding: CGFloat = 38
    var followsEnd: () -> Bool = { false }
    /// The controller's measured height for a row, nil until it has one.
    var height: (String) -> CGFloat? = { _ in nil }
    /// A cell reported a different height (its own state changed, such as a card expanding).
    var selfSized: (String, CGFloat) -> Void = { _, _ in }
    private(set) var frames: [CGRect] = []
    private var width: CGFloat = 0
    private var contentHeight: CGFloat = 0
    static let estimate: CGFloat = 120

    override func prepare() {
        super.prepare()
        guard let cv = collectionView else { return }
        width = cv.bounds.width
        let count = cv.numberOfSections > 0 ? cv.numberOfItems(inSection: 0) : 0
        frames.removeAll(keepingCapacity: true)
        var y = topPadding
        for (index, item) in items.prefix(count).enumerated() {
            if index > 0 { y += item.gap }
            let height = height(item.id) ?? Self.estimate
            frames.append(CGRect(x: 0, y: y, width: width, height: height))
            y += height
        }
        contentHeight = frames.isEmpty ? 0 : y + bottomPadding
        // A thread shorter than the screen sits at the bottom, against the composer, so the end
        // stays where it is as messages arrive and the thread grows upward.
        let visible = cv.bounds.height - cv.adjustedContentInset.top - cv.adjustedContentInset.bottom
        if !frames.isEmpty, contentHeight < visible {
            let shift = visible - contentHeight
            frames = frames.map { $0.offsetBy(dx: 0, dy: shift) }
            contentHeight = visible
        }
    }

    override var collectionViewContentSize: CGSize {
        CGSize(width: width, height: contentHeight)
    }

    /// The first row whose bottom is below `y`.
    func firstIndex(endingBelow y: CGFloat) -> Int? {
        var low = 0
        var high = frames.count
        while low < high {
            let mid = (low + high) / 2
            if frames[mid].maxY <= y { low = mid + 1 } else { high = mid }
        }
        return low < frames.count ? low : nil
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        guard var index = firstIndex(endingBelow: rect.minY) else { return [] }
        var result: [UICollectionViewLayoutAttributes] = []
        while index < frames.count, frames[index].minY <= rect.maxY {
            result.append(attributes(index))
            index += 1
        }
        return result
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        indexPath.item < frames.count ? attributes(indexPath.item) : nil
    }

    private func attributes(_ index: Int) -> UICollectionViewLayoutAttributes {
        let attributes = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: index, section: 0))
        attributes.frame = frames[index]
        return attributes
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        newBounds.width != width
    }

    override func shouldInvalidateLayout(
        forPreferredLayoutAttributes preferred: UICollectionViewLayoutAttributes,
        withOriginalAttributes original: UICollectionViewLayoutAttributes
    ) -> Bool {
        // Rows arrive measured; only a real change inside a cell (more than a point) counts.
        abs(preferred.size.height - original.size.height) > 1
    }

    override func invalidationContext(
        forPreferredLayoutAttributes preferred: UICollectionViewLayoutAttributes,
        withOriginalAttributes original: UICollectionViewLayoutAttributes
    ) -> UICollectionViewLayoutInvalidationContext {
        let context = super.invalidationContext(forPreferredLayoutAttributes: preferred, withOriginalAttributes: original)
        let index = original.indexPath.item
        guard index < items.count, index < frames.count, let cv = collectionView else { return context }
        let id = items[index].id
        let old = frames[index]
        let delta = preferred.size.height - old.height
        selfSized(id, preferred.size.height)
        let top = cv.contentOffset.y + cv.adjustedContentInset.top
        // A row wholly above the reader moves the offset with it. Growth in view or below never
        // does; the end-follow keeps the end in place while pinned.
        if !followsEnd() && old.maxY <= top + 0.5 {
            context.contentOffsetAdjustment = CGPoint(x: 0, y: delta)
        }
        context.contentSizeAdjustment = CGSize(width: 0, height: delta)
        return context
    }
}

/// Hosts one SwiftUI row. A hosting controller with no safe-area regions, like the composer's:
/// `UIHostingConfiguration` padded rows for the navigation bar and composer areas they scrolled
/// under, so they grew and shrank as they moved. The off-screen sizer uses the same setup.
final class FeedCell: UICollectionViewCell {
    private let host = UIHostingController(rootView: AnyView(EmptyView()))

    override init(frame: CGRect) {
        super.init(frame: frame)
        host.safeAreaRegions = []
        host.view.backgroundColor = .clear
        host.view.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: contentView.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func show(_ content: AnyView) {
        host.rootView = content
    }

    /// The row's own size at the cell's width; differs from the layout only when the row's state
    /// changed inside the cell.
    override func preferredLayoutAttributesFitting(
        _ layoutAttributes: UICollectionViewLayoutAttributes
    ) -> UICollectionViewLayoutAttributes {
        let attributes = layoutAttributes.copy() as! UICollectionViewLayoutAttributes
        let size = host.sizeThatFits(in: CGSize(width: layoutAttributes.size.width, height: .greatestFiniteMagnitude))
        let scale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 3
        attributes.size = CGSize(width: layoutAttributes.size.width, height: (size.height * scale).rounded(.up) / scale)
        return attributes
    }
}

/// Passes touches through except over the floating buttons, so the feed under the empty part of
/// the row still scrolls and takes taps.
final class PassthroughView: UIView {
    var interactiveFrame: CGRect = .zero

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard interactiveFrame.insetBy(dx: -4, dy: -4).contains(point) else { return nil }
        return super.hitTest(point, with: event)
    }
}

/// UI tests only (`CONN_FEED_PROBE`): the feed's scroll state as an accessibility value, and
/// how many frames were drawn and how many were late (hitches) since launch.
final class FeedProbeView: UIView {
    private var link: CADisplayLink?
    private var frames = 0
    private var hitches = 0
    private var last: CFTimeInterval = 0
    private var state = ""

    override init(frame: CGRect) {
        super.init(frame: frame)
        isAccessibilityElement = true
        accessibilityIdentifier = "thread.feedProbe"
        accessibilityLabel = "feed probe"
        isUserInteractionEnabled = false
        backgroundColor = UIColor.black.withAlphaComponent(0.01)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        link?.invalidate()
        link = nil
        guard window != nil else { return }
        let link = CADisplayLink(target: ProbeTicker(self), selector: #selector(ProbeTicker.tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    fileprivate func tick(_ link: CADisplayLink) {
        if last > 0 {
            frames += 1
            // Late by more than half a frame: a hitch.
            if link.timestamp - last > (link.targetTimestamp - link.timestamp) * 1.5 { hitches += 1 }
        }
        last = link.timestamp
        publish()
    }

    private func publish() {
        let value = state + " fr=\(frames) hitch=\(hitches)"
        if accessibilityValue != value { accessibilityValue = value }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func report(_ cv: UICollectionView, pinned: Bool, distance: CGFloat, layout: FeedLayout, order: [String]) {
        let value = String(format: "y=%.1f max=%.1f dist=%.1f h=%.1f vh=%.1f it=%.1f ib=%.1f pin=%d drag=%d dec=%d n=%d",
                           cv.contentOffset.y, cv.contentOffset.y + distance, distance, cv.contentSize.height,
                           cv.bounds.height, cv.adjustedContentInset.top, cv.adjustedContentInset.bottom,
                           pinned ? 1 : 0, cv.isDragging ? 1 : 0, cv.isDecelerating ? 1 : 0, order.count)
        state = value
        publish()
    }
}

@MainActor
private final class ProbeTicker: NSObject {
    weak var probe: FeedProbeView?
    init(_ probe: FeedProbeView) { self.probe = probe }
    @objc func tick(_ link: CADisplayLink) { probe?.tick(link) }
}
