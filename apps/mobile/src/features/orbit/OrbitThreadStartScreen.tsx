import {
  resolveOrbitLaunchError,
  startableOrbitProject,
  type OrbitGatewayProject,
  type OrbitLaunchSubmission,
} from "@t3tools/client-runtime/orbit-gateway";
import {
  StackActions,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import { T, msg, useGT } from "gt-react-native";
import { useEffect, useRef, useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { m } from "../../i18n/messages";
import { orbitGatewayClient } from "./orbitGatewayClient";
import { useOrbitGateway } from "./orbitGatewayStore";
import {
  acknowledgeMobileOrbitLaunch,
  mobileOrbitSubmissions,
  startOrbitThread,
} from "./orbitThreadStartRuntime";
import { orbitStartReturn } from "./orbitThreadStarts";

/**
 * Conn: starts a thread in an Orbit Project. Orbit creates a clone of the Project's default
 * Instance, and the thread starts there with the first message (FORK.md, "Orbit").
 */
export function OrbitThreadStartScreen({
  route,
}: StaticScreenProps<{ readonly refusedAdmissionId: string } | undefined>) {
  const gt = useGT();
  const navigation = useNavigation();
  const { key: sheetKey } = useRoute();
  const refusedAdmissionId = route.params?.refusedAdmissionId;
  const gateway = useOrbitGateway();
  const profileId = gateway.node?.profile?.id;
  const nodeId = gateway.node?.id;
  const insets = useSafeAreaInsets();
  const [projects, setProjects] = useState<readonly OrbitGatewayProject[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosenId, setChosenId] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [recovery, setRecovery] = useState<OrbitLaunchSubmission | null>(null);
  const started = useRef(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Gateway's Projects once when the screen opens
  useEffect(() => {
    let current = true;
    orbitGatewayClient.projects().then(
      (list) => current && setProjects(list.flatMap((row) => startableOrbitProject(row) ?? [])),
      (error: unknown) =>
        current &&
        setLoadError(resolveOrbitLaunchError(error, msg("Could not load Orbit projects."), m)),
    );
    return () => {
      current = false;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reopen a refused message from the current profile's durable journal
  useEffect(() => {
    if (refusedAdmissionId === undefined || profileId === undefined || nodeId === undefined) return;
    let current = true;
    void mobileOrbitSubmissions.pending({ profileId, nodeId }).then(
      (records) => {
        if (!current) return;
        const record = records.find(
          (row) =>
            row.admission.id === refusedAdmissionId && row.validationRefused && !row.superseded,
        );
        if (record === undefined) {
          setSendError(m(msg("This submission was already handled.")));
          return;
        }
        setRecovery(record);
        setChosenId(record.admission.request.project_id);
        setText(record.admission.request.prompt);
      },
      () => {
        if (current) setSendError(m(msg("Conn could not read its Orbit submission journal.")));
      },
    );
    return () => {
      current = false;
    };
  }, [refusedAdmissionId, profileId, nodeId]);

  const canEdit =
    refusedAdmissionId === undefined ||
    (recovery?.admission.id === refusedAdmissionId &&
      recovery.profileId === profileId &&
      recovery.nodeId === nodeId);
  const project = projects?.find((entry) => entry.id === chosenId) ?? projects?.[0] ?? null;
  const canStart = canEdit && project !== null && text.trim() !== "";
  const goBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.getParent()?.goBack();
  };
  const start = async () => {
    if (started.current || !canStart || project === null) return;
    started.current = true;
    setSending(true);
    setSendError(null);
    const { back } = orbitStartReturn(navigation.getState());
    try {
      const launch = await startOrbitThread(project, text.trim(), sheetKey, recovery ?? undefined);
      if (navigation.isFocused()) {
        navigation.dispatch(StackActions.pop(back));
        await acknowledgeMobileOrbitLaunch(launch.launch_id).catch(() => {});
      }
    } catch (error) {
      setSendError(resolveOrbitLaunchError(error, msg("Orbit did not confirm the launch."), m));
    }
    started.current = false;
    setSending(false);
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar title={gt("Orbit project")} hideBottomBorder onBack={goBack} />
      <ScreenContent>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          className="flex-1"
          contentContainerStyle={{
            gap: 20,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
            paddingHorizontal: Platform.OS === "android" ? 16 : 20,
            paddingTop: 8,
          }}
        >
          <Text className="px-2 text-sm leading-normal text-foreground-muted">
            <T>
              Orbit creates a clone of the project's default instance, and the thread starts there
              with this message.
            </T>
          </Text>
          {loadError ? <ErrorBanner message={loadError} /> : null}
          {sendError ? <ErrorBanner message={sendError} /> : null}
          <ListSection title={gt("Project")}>
            {projects === null ? (
              loadError ? null : (
                <View className="items-center p-4">
                  <AppActivityIndicator colorClassName="accent-icon-muted" />
                </View>
              )
            ) : projects.length === 0 ? (
              <Text className="p-4 text-sm leading-normal text-foreground-muted">
                <T>
                  No Orbit project has a default instance in a container that this device reaches.
                </T>
              </Text>
            ) : (
              projects.map((entry, index) => (
                <ListChoiceRow
                  key={entry.id}
                  label={entry.name}
                  description={entry.nodeName}
                  selected={entry.id === project?.id}
                  separated={index > 0}
                  onPress={() => {
                    if (!started.current) setChosenId(entry.id);
                  }}
                />
              ))
            )}
          </ListSection>
          <ListSection title={gt("First message")}>
            <TextInput
              accessibilityLabel={gt("First message")}
              value={text}
              onChangeText={setText}
              editable={canEdit && !sending}
              multiline
              scrollEnabled
              textAlignVertical="top"
              placeholder={gt("What should the agent do?")}
              placeholderTextColorClassName="accent-foreground-muted"
              className="max-h-48 min-h-28 p-4 font-sans text-base text-foreground"
            />
          </ListSection>
          <Button
            label={sending ? gt("Sending…") : gt("Start thread")}
            tone="primary"
            fullWidth
            disabled={!canStart || sending}
            onPress={() => void start()}
          />
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
