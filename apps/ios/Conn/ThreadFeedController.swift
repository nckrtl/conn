import SwiftUI
import UIKit

/// One feed row: its id (the diffable item), the space above it, and its SwiftUI content.
struct FeedRow {
    let id: String
    let gap: CGFloat
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
    func isOpen(_ key: String) -> Bool { open.contains(key) }
    func toggle(_ key: String) {
        if open.remove(key) == nil { open.insert(key) }
    }
}

extension EnvironmentValues {
    @Entry var feedExpansion: FeedExpansion?
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
        view.addSubview(cv)

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
        layout.forgetHeights()
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
        rows = Dictionary(unique.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let ids = unique.map(\.id)
        let items = unique.map { FeedLayout.Item(id: $0.id, gap: $0.gap) }
        let anchor = pinned ? nil : captureAnchor()
        let paddingChanged = layout.bottomPadding != bottomPadding
        layout.bottomPadding = bottomPadding

        if ids != order {
            // The cells' ids under the old order, before it changes.
            let live = liveIds().filter { seen.contains($0) }
            order = ids
            layout.items = items
            var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
            snapshot.appendSections([0])
            snapshot.appendItems(ids)
            snapshot.reconfigureItems(live)
            dataSource.apply(snapshot, animatingDifferences: false)
        } else {
            let gapsChanged = layout.items != items
            layout.items = items
            if gapsChanged || paddingChanged { layout.invalidateLayout() }
            let live = liveIds()
            if !live.isEmpty {
                var snapshot = dataSource.snapshot()
                snapshot.reconfigureItems(live)
                dataSource.apply(snapshot, animatingDifferences: false)
            }
        }
        if let anchor { restore(anchor) } else { collectionView.setNeedsLayout() }
        updateChrome()
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

    // MARK: - Cells

    private func configure(_ cell: FeedCell, id: String) {
        guard let row = rows[id] else {
            cell.contentConfiguration = nil
            return
        }
        let theme = theme
        let expansion = expansion
        cell.contentConfiguration = UIHostingConfiguration {
            row.content()
                .environment(\.connTheme, theme)
                .environment(\.feedExpansion, expansion)
                .id(id)
        }
        .margins(.all, 0)
        .minSize(width: 0, height: 0)
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
        let y = scrollView.contentOffset.y
        if scrollView.isDragging, y < lastOffset, y + scrollView.adjustedContentInset.top < 160 {
            reachTopArmed = true
        }
        lastOffset = y
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
    private(set) var frames: [CGRect] = []
    private var heights: [String: CGFloat] = [:]
    private var width: CGFloat = 0
    private var contentHeight: CGFloat = 0
    private static let estimate: CGFloat = 120

    func forgetHeights() {
        heights.removeAll()
        invalidateLayout()
    }

    override func prepare() {
        super.prepare()
        guard let cv = collectionView else { return }
        if cv.bounds.width != width {
            if width != 0 { heights.removeAll() }
            width = cv.bounds.width
        }
        let count = cv.numberOfSections > 0 ? cv.numberOfItems(inSection: 0) : 0
        frames.removeAll(keepingCapacity: true)
        var y = topPadding
        for (index, item) in items.prefix(count).enumerated() {
            if index > 0 { y += item.gap }
            let height = heights[item.id] ?? Self.estimate
            frames.append(CGRect(x: 0, y: y, width: width, height: height))
            y += height
        }
        contentHeight = frames.isEmpty ? 0 : y + bottomPadding
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
        let index = original.indexPath.item
        guard index < items.count else { return false }
        if abs(preferred.size.height - original.size.height) <= 0.5 {
            if heights[items[index].id] == nil { heights[items[index].id] = original.size.height }
            return false
        }
        return true
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
        let firstMeasure = heights[id] == nil
        heights[id] = preferred.size.height
        let top = cv.contentOffset.y + cv.adjustedContentInset.top
        // A row wholly above the reader, or one measured for the first time as it comes in at the
        // top edge, moves the offset with it. Growth in view (streaming) or below never does; the
        // end-follow keeps the end in place while pinned.
        let above = old.maxY <= top + 0.5 || (firstMeasure && old.minY < top)
        if !followsEnd() && above {
            context.contentOffsetAdjustment = CGPoint(x: 0, y: delta)
        }
        context.contentSizeAdjustment = CGSize(width: 0, height: delta)
        return context
    }
}

/// Sizes itself to its SwiftUI content at the layout's width.
final class FeedCell: UICollectionViewCell {
    override func preferredLayoutAttributesFitting(
        _ layoutAttributes: UICollectionViewLayoutAttributes
    ) -> UICollectionViewLayoutAttributes {
        let attributes = layoutAttributes.copy() as! UICollectionViewLayoutAttributes
        let size = contentView.systemLayoutSizeFitting(
            CGSize(width: layoutAttributes.size.width, height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .required,
            verticalFittingPriority: .fittingSizeLevel
        )
        attributes.size = CGSize(width: layoutAttributes.size.width, height: size.height)
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
