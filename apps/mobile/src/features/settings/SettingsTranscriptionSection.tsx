import { useEffect, useState, useSyncExternalStore } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import {
  getOperatorTranscriptionSettings,
  loadOperatorTranscriptionSettings,
  saveOperatorTranscriptionSettings,
  subscribeOperatorTranscriptionSettings,
  testOperatorServer,
} from "../voice-input/operatorTranscription";
import { SettingsSection } from "./components/SettingsSection";

type TestResult =
  | { readonly kind: "idle" }
  | { readonly kind: "testing" }
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly message: string };

const INPUT_CLASS =
  "min-h-11 min-w-0 flex-1 rounded-xl border-continuous bg-card px-3 text-base text-foreground";

export function SettingsTranscriptionSection() {
  const settings = useSyncExternalStore(
    subscribeOperatorTranscriptionSettings,
    getOperatorTranscriptionSettings,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the settings from the keychain once
  useEffect(() => void loadOperatorTranscriptionSettings(), []);
  const [addresses, setAddresses] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult>({ kind: "idle" });

  const draftAddresses = addresses ?? settings.addresses;
  const draftToken = token ?? settings.token;
  const dirty = draftAddresses !== settings.addresses || draftToken !== settings.token;

  const save = () =>
    void saveOperatorTranscriptionSettings({
      addresses: draftAddresses.trim(),
      token: draftToken.trim(),
    }).then(() => {
      setAddresses(null);
      setToken(null);
    });
  const runTest = () => {
    setTest({ kind: "testing" });
    testOperatorServer(draftAddresses, draftToken).then(
      () => setTest({ kind: "ok" }),
      (error: unknown) =>
        setTest({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error),
        }),
    );
  };

  return (
    <>
      <SettingsSection title="Transcription">
        <ListChoiceRow
          label="On this device"
          description="Apple speech recognition, offline"
          selected={settings.engine === "device"}
          disabled={!settings.loaded}
          onPress={() => void saveOperatorTranscriptionSettings({ engine: "device" })}
        />
        <ListChoiceRow
          label="Operator server"
          description="Higher quality; sends recordings to your server"
          selected={settings.engine === "operator"}
          separated
          disabled={!settings.loaded}
          onPress={() => void saveOperatorTranscriptionSettings({ engine: "operator" })}
        />
      </SettingsSection>
      {settings.engine === "operator" ? (
        <>
          <SettingsSection title="Operator server">
            <View className="gap-3 p-4">
              <Text className="text-sm font-t3-medium text-foreground-muted">Address</Text>
              <AppTextInput
                accessibilityLabel="Operator server address"
                className={INPUT_CLASS}
                value={draftAddresses}
                onChangeText={(value) => {
                  setAddresses(value);
                  setTest({ kind: "idle" });
                }}
                placeholder="https://operator.test"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="done"
                onSubmitEditing={save}
              />
              <Text className="text-sm font-t3-medium text-foreground-muted">Token</Text>
              <AppTextInput
                accessibilityLabel="Operator client token"
                className={INPUT_CLASS}
                value={draftToken}
                onChangeText={(value) => {
                  setToken(value);
                  setTest({ kind: "idle" });
                }}
                placeholder="Client token"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                returnKeyType="done"
                onSubmitEditing={save}
              />
              <View className="flex-row gap-3">
                <Button
                  label="Test"
                  tone="secondary"
                  loading={test.kind === "testing"}
                  onPress={runTest}
                />
                {dirty ? <Button label="Save" tone="primary" onPress={save} /> : null}
              </View>
              {test.kind === "ok" ? (
                <Text className="text-sm text-foreground-muted">Connected. The token works.</Text>
              ) : test.kind === "failed" ? (
                <Text className="text-sm text-danger-foreground">{test.message}</Text>
              ) : null}
            </View>
          </SettingsSection>
          <Text className="px-2 text-sm text-foreground-muted">
            Use the address and client token from your Operator server, as in the Operator app.
            Separate several addresses with commas; they are tried in order. Without a scheme, http
            is used.
          </Text>
        </>
      ) : null}
    </>
  );
}
