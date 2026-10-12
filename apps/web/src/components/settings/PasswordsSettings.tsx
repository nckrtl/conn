import { type CredentialAutofillSettings } from "@t3tools/contracts";
import type { TestLoginSummary } from "@t3tools/contracts";
import { useState } from "react";

import { TestLoginDialog } from "~/credentials/TestLoginDialog";
import { VaultwardenSettings } from "./VaultwardenSettings";
import { VaultProviderRow } from "./VaultProviderRow";
import { useAtomCommand } from "~/state/use-atom-command";

import { credentialsEnvironment } from "~/state/credentials";
import { useEnvironmentQuery } from "~/state/query";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** T3 Code's own logins for test users, listed for one environment. */
function TestLoginsSection() {
  const { environment } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  const logins = useEnvironmentQuery(
    environmentId === null ? null : credentialsEnvironment.testLogins({ environmentId, input: {} }),
  );
  const remove = useAtomCommand(credentialsEnvironment.removeTestLogin);
  const [dialog, setDialog] = useState<{ readonly login?: TestLoginSummary } | null>(null);
  const items = logins.data?.items ?? [];

  return (
    <SettingsSection
      id={searchableSetting("test-logins").id}
      title="Test logins"
      headerAction={
        environmentId === null ? null : (
          <Button size="xs" variant="outline" onClick={() => setDialog({})}>
            Add test login
          </Button>
        )
      }
    >
      {environmentId === null ? (
        <SettingsRow
          title="Test logins"
          description="Connect an environment to see its test logins."
        />
      ) : items.length === 0 ? (
        <SettingsRow
          title="No test logins yet"
          description="Save test users of sites you develop here, or let an agent save the users it creates. They fill without a prompt."
        />
      ) : (
        items.map((login) => (
          <SettingsRow
            key={login.id}
            title={login.label || login.username}
            description={
              <span className="flex flex-wrap gap-x-2">
                <span>{login.username}</span>
                <span className="text-muted-foreground/70">{login.url}</span>
                {login.hasOtp ? <span>one-time code</span> : null}
                {login.createdBy === "agent" ? <span>saved by an agent</span> : null}
              </span>
            }
            control={
              <span className="flex gap-1.5">
                <Button size="xs" variant="outline" onClick={() => setDialog({ login })}>
                  Edit
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void remove({ environmentId, input: { id: login.id } }).then(() =>
                      logins.refresh(),
                    )
                  }
                >
                  Delete
                </Button>
              </span>
            }
          />
        ))
      )}
      {environmentId === null ? null : (
        <TestLoginDialog
          environmentId={environmentId}
          open={dialog !== null}
          onOpenChange={(open) => (open ? undefined : setDialog(null))}
          login={dialog?.login}
          onSaved={() => logins.refresh()}
        />
      )}
    </SettingsSection>
  );
}

export function PasswordsSettingsPanel() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const autofill = settings.credentialAutofill;
  const update = (patch: Partial<CredentialAutofillSettings>) =>
    updateSettings({ credentialAutofill: patch });

  return (
    <SettingsPageContainer>
      <VaultwardenSettings />
      <SettingsSection id={searchableSetting("password-manager").id} title="Password manager">
        <VaultProviderRow />
      </SettingsSection>
      <TestLoginsSection />

      <SettingsSection title="Protection">
        <SettingsRow
          title="Hide passwords from page reads"
          description="Always on. Page text and script results the agent reads show [redacted] in place of password and code values."
          control={<Switch aria-label="Hide passwords from page reads" checked disabled />}
        />
        <SettingsRow
          serverScoped
          settingKeys={["credentialAutofill"]}
          id={searchableSetting("credential-block-scripts").id}
          title="Block agent scripts after a fill"
          description="After a password or code fills, the agent can't run JavaScript in that tab until a new page loads. Stops a script from copying the value out."
          control={
            <Switch
              aria-label="Block agent scripts after a fill"
              checked={autofill.blockScriptsAfterFill}
              onCheckedChange={(enabled) => update({ blockScriptsAfterFill: enabled })}
            />
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["credentialAutofill"]}
          id={searchableSetting("credential-subdomains").id}
          title="Fill on subdomains of a saved site"
          description="A test login saved for example.com also fills login.example.com. Off: only the exact saved site."
          control={
            <Switch
              aria-label="Fill on subdomains of a saved site"
              checked={autofill.allowSubdomains}
              onCheckedChange={(enabled) => update({ allowSubdomains: enabled })}
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
