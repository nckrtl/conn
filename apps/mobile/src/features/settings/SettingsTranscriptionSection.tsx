import { useAtomValue } from "@effect/atom-react";
import { chooseVoiceDestination, voiceGrantAtom } from "../voice-input/voiceDestination";
import { useEffect, useState, useSyncExternalStore } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import {
  getOperatorTranscriptionSettings,
  loadOperatorTranscriptionSettings,
  saveOperatorTranscriptionSettings,
  signInToOperator,
  signOutOfOperator,
  subscribeOperatorTranscriptionSettings,
} from "../voice-input/operatorTranscription";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsTranscriptionSection() {
  const grant = useAtomValue(voiceGrantAtom);
  const selectEngine = async (engine: "device" | "operator") => {
    try {
      await saveOperatorTranscriptionSettings({ engine });
      chooseVoiceDestination(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const settings = useSyncExternalStore(
    subscribeOperatorTranscriptionSettings,
    getOperatorTranscriptionSettings,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the settings from the keychain once
  useEffect(() => void loadOperatorTranscriptionSettings(), []);
  const [server, setServer] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draftServer = server ?? settings.server;
  const signedIn = settings.token.length > 0;

  const signIn = () => {
    setSigningIn(true);
    setError(null);
    signInToOperator(draftServer).then(
      (signedIn) => {
        if (signedIn) chooseVoiceDestination(null);
        setSigningIn(false);
        setServer(null);
      },
      (cause: unknown) => {
        setSigningIn(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  return (
    <>
      <SettingsSection title="Transcription">
        <ListChoiceRow
          label="On this device"
          description="Apple speech recognition, offline"
          selected={!grant && settings.engine === "device"}
          disabled={!settings.loaded}
          onPress={() => void selectEngine("device")}
        />
        <ListChoiceRow
          label="Operator server"
          description="Higher quality; sends recordings to your server"
          selected={!grant && settings.engine === "operator"}
          separated
          disabled={!settings.loaded}
          onPress={() => void selectEngine("operator")}
        />
      </SettingsSection>
      {settings.engine === "operator" ? (
        <SettingsSection title="Operator server">
          {signedIn ? (
            <View className="flex-row items-center gap-3 p-4">
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-base font-t3-medium text-foreground">Signed in</Text>
                <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                  {[settings.account, settings.server.replace(/^https?:\/\//, "")]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </View>
              <Button label="Sign out" tone="secondary" onPress={() => void signOutOfOperator()} />
            </View>
          ) : (
            <View className="gap-3 p-4">
              <AppTextInput
                accessibilityLabel="Operator server address"
                className="min-h-11 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
                value={draftServer}
                onChangeText={(value) => {
                  setServer(value);
                  setError(null);
                }}
                placeholder="https://operator.test"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                editable={!signingIn}
                onSubmitEditing={signIn}
              />
              <Button
                label="Sign in"
                tone="primary"
                loading={signingIn}
                disabled={draftServer.trim().length === 0}
                onPress={signIn}
              />
              {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
            </View>
          )}
        </SettingsSection>
      ) : null}
    </>
  );
}
