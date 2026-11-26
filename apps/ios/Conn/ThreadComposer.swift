import DesignKit
import SwiftUI
import UIKit

/// The thread's bottom bar: the approval and question cards, and the composer. It is the only part
/// of the thread screen that reads the draft, so typing re-runs this body and not the feed's.
struct ThreadComposerArea: View {
    @Bindable var store: CoreStore
    let threadId: String
    let pendingApprovals: [FfiPendingApproval]
    let pendingQuestion: FfiPendingQuestion?
    let isWorking: Bool
    /// An older window of the thread is on screen: nothing can be sent.
    let readingHistory: Bool
    let historyNotice: String?
    let viewHeight: CGFloat
    let modelDriver: String?
    let modelLabel: String?
    let onModelChip: () -> Void
    let onSendReply: () -> Void

    @Environment(\.connTheme) private var theme
    /// The approval whose answer is on its way; its buttons stay off until the server answers.
    @State private var respondingApprovalId: String?
    /// Each open question's answers so far, by request id, then question id.
    @State private var questionDrafts: [String: [String: FfiQuestionDraft]] = [:]
    /// The step each open question shows, by request id.
    @State private var questionSteps: [String: Int] = [:]
    /// The question whose answers are on their way.
    @State private var respondingUserInputId: String?
    /// The step whose single-choice pick is about to move on (mobile's 200 ms).
    @State private var advancingStep: Int?
    @State private var advanceTask: Task<Void, Never>?

    private var composer: ComposerDraft { store.composerDraft(.thread(threadId)) }
    private var draft: String {
        get { composer.text }
        nonmutating set { composer.text = newValue }
    }

    /// An approval gives up height to the feed: at most 560pt, at least 160pt, and never more
    /// than the screen leaves above the composer (`derivePendingUserInputMaxHeight`).
    private var approvalMaxHeight: CGFloat {
        min(560, max(160, viewHeight - 140))
    }

    /// The panel leaves some of the feed in view above itself (`QUESTION_PANEL_FEED_PEEK`).
    private var questionMaxHeight: CGFloat {
        min(560, max(160, viewHeight - 140 - 96))
    }

    /// The open question's panel for its current step; the composer's text shows as the answer.
    private var questionPanelModel: FfiQuestionPanel? {
        guard let question = pendingQuestion else { return nil }
        return questionPanel(
            pending: question,
            step: UInt32(clamping: questionSteps[question.requestId] ?? 0),
            drafts: questionDrafts[question.requestId] ?? [:],
            typedAnswer: draft,
            responding: respondingUserInputId == question.requestId
        )
    }

    private var hasDraft: Bool {
        pendingQuestion == nil ? composer.hasContent : !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// With a question open, text answers it and an empty composer runs the answer action.
    private var overlayHasCards: Bool {
        !pendingApprovals.isEmpty || questionPanelModel != nil
            || historyNotice != nil || (store.showsOffline && !store.showsSavedConnectionAlert)
    }

    private var composerCanSend: Bool {
        guard store.status == .connected, !readingHistory else { return false }
        // `conn-server` refuses a queued message without text.
        if composer.queuedEdit != nil {
            return !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !composer.locked
        }
        guard let question = pendingQuestion, let panel = questionPanelModel else {
            return hasDraft && !composer.locked
        }
        if hasDraft {
            return panel.acceptsText && question.answerable
                && respondingUserInputId != question.requestId
        }
        return panel.answerActionReady
    }

    var body: some View {
        GlassEffectContainer(spacing: 8) {
          VStack(alignment: .leading, spacing: 0) {
          VStack(alignment: .leading, spacing: 10.5) {
            if let historyNotice {
                Text(historyNotice).font(.kitDetail)
            }
            if store.showsOffline && !store.showsSavedConnectionAlert {
                OfflinePill(store: store).frame(maxWidth: .infinity)
            }
            // Conn mobile pins the first pending approval above the composer.
            if let approval = pendingApprovals.first {
                HeightCappedScroll(maxHeight: approvalMaxHeight) {
                    PendingApprovalCard(
                        approval: approval,
                        remaining: pendingApprovals.count,
                        responding: respondingApprovalId == approval.requestId
                    ) { decision in
                        respond(to: approval, with: decision)
                    }
                }
                .modifier(ComposerDeck(remaining: pendingApprovals.count))
                .id(approval.requestId)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            if let question = pendingQuestion, let panel = questionPanelModel {
                PendingUserInputCard(
                    question: question,
                    panel: panel,
                    responding: respondingUserInputId == question.requestId,
                    advancing: advancingStep == Int(panel.step),
                    maxHeight: questionMaxHeight,
                    onSelectOption: { value in
                        selectQuestionOption(value, question: question, panel: panel)
                    },
                    onStepChange: { step in
                        UISelectionFeedbackGenerator().selectionChanged()
                        setQuestionStep(step, for: question)
                    },
                    onSubmit: { submitQuestion(question) },
                    onDismiss: { dismissQuestion(question) }
                )
                .modifier(ComposerDeck(remaining: question.questions.count - Int(panel.step)))
                .id(question.requestId)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
          }
          // Cards: `px-[14px] pb-[7px] gap-2.5` (2pt more than the composer's 12).
          .padding(.horizontal, 2)
          .padding(.bottom, overlayHasCards ? 7 : 0)

            ConnComposerPill(
                placeholder: composer.queuedEdit != nil ? "Edit queued message"
                    : questionPanelModel?.composerPlaceholder ?? (isWorking ? "Queue a follow-up…" : "Ask anything"),
                draft: composer,
                limits: store.composerLimits,
                allowsAttachments: questionPanelModel == nil,
                isBusy: isWorking && !hasDraft && questionPanelModel == nil && composer.queuedEdit == nil,
                canSend: composerCanSend,
                onSend: {
                    if composer.queuedEdit != nil {
                        Task { await store.saveQueuedEdit(threadId: threadId) }
                    } else if let question = pendingQuestion, let panel = questionPanelModel {
                        if hasDraft {
                            answerQuestion(with: draft, question: question, panel: panel)
                        } else {
                            runAnswerAction(question: question, panel: panel)
                        }
                    } else {
                        onSendReply()
                    }
                },
                onStop: {
                    Task {
                        await store.stopThread(threadId: threadId)
                    }
                },
                trailing: {
                    HStack(spacing: 0) {
                        if isWorking && hasDraft && questionPanelModel == nil && composer.queuedEdit == nil {
                            Button {
                                Task {
                                    await store.stopThread(threadId: threadId)
                                }
                            } label: {
                                // Lab `.ios-stop`: a bare 13 pt `stop` in the text colour.
                                ThreadGlyph(name: "stop", size: 13)
                                    .foregroundStyle(theme.foreground)
                                    .frame(minHeight: 44)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Stop")
                        }
                        ConnComposerModelChip(driver: modelDriver, modelLabel: modelLabel, action: onModelChip)
                    }
                }
            )
            .id(ObjectIdentifier(composer))
            .disabled(store.status != .connected || readingHistory)
            .accessibilityIdentifier("thread.composer")
          }
        }
        // `ThreadComposer`: `px-[12px]`, and 2pt (`COMPOSER_BOTTOM_GUTTER`) above the safe area.
        .padding(.horizontal, ComposerSheet.screenInset)
        .padding(.bottom, ComposerSheet.bottomGutter)
        .onChange(of: pendingQuestion?.requestId) { _, current in
            // Drafts of answered, skipped or expired questions go (`pruneResolvedRequestDrafts`).
            questionDrafts = questionDrafts.filter { $0.key == current }
            questionSteps = questionSteps.filter { $0.key == current }
        }
    }

    private func setQuestionStep(_ step: Int, for question: FfiPendingQuestion) {
        advanceTask?.cancel()
        advanceTask = nil
        advancingStep = nil
        questionSteps[question.requestId] = max(0, step)
    }

    private func selectQuestionOption(_ value: String, question: FfiPendingQuestion, panel: FfiQuestionPanel) {
        UISelectionFeedbackGenerator().selectionChanged()
        questionDrafts[question.requestId] = questionToggleOption(
            pending: question,
            questionId: panel.questionId,
            drafts: questionDrafts[question.requestId] ?? [:],
            value: value
        )
        guard panel.advancesOnPick else { return }
        advanceTask?.cancel()
        let step = Int(panel.step)
        advancingStep = step
        advanceTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            advanceTask = nil
            advancingStep = nil
            questionSteps[question.requestId] = step + 1
        }
    }

    private func submitQuestion(_ question: FfiPendingQuestion) {
        guard let answers = questionAnswers(
            pending: question,
            drafts: questionDrafts[question.requestId] ?? [:]
        ) else { return }
        respondingUserInputId = question.requestId
        Task {
            await store.respondUserInput(threadId: threadId, requestId: question.requestId, answers: answers)
            if respondingUserInputId == question.requestId {
                respondingUserInputId = nil
            }
        }
    }

    private func dismissQuestion(_ question: FfiPendingQuestion) {
        respondingUserInputId = question.requestId
        Task {
            await store.dismissUserInput(threadId: threadId, requestId: question.requestId)
            if respondingUserInputId == question.requestId {
                respondingUserInputId = nil
            }
        }
    }

    /// Text sent while a question is open answers it: the prompt box is the free-text answer.
    private func answerQuestion(with text: String, question: FfiPendingQuestion, panel: FfiQuestionPanel) {
        questionDrafts[question.requestId] = questionSetCustomAnswer(
            pending: question,
            questionId: panel.questionId,
            drafts: questionDrafts[question.requestId] ?? [:],
            text: text
        )
        draft = ""
        if panel.isLast {
            submitQuestion(question)
        } else {
            setQuestionStep(Int(panel.step) + 1, for: question)
        }
    }

    /// The composer's send button with no text: the next question, or the answers.
    private func runAnswerAction(question: FfiPendingQuestion, panel: FfiQuestionPanel) {
        if panel.isLast {
            submitQuestion(question)
        } else {
            setQuestionStep(Int(panel.step) + 1, for: question)
        }
    }

    private func respond(to approval: FfiPendingApproval, with decision: FfiApprovalDecision) {
        respondingApprovalId = approval.requestId
        Task {
            await store.respondApproval(
                threadId: threadId,
                requestId: approval.requestId,
                decision: decision
            )
            if respondingApprovalId == approval.requestId {
                respondingApprovalId = nil
            }
        }
    }
}
