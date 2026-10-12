import type { EnvironmentId, TestLoginSummary } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { toastManager } from "~/components/ui/toast";
import { credentialsEnvironment } from "~/state/credentials";
import { useAtomCommand } from "~/state/use-atom-command";

interface TestLoginDialogProps {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Editing this login; omit to add a new one. */
  readonly login?: TestLoginSummary | undefined;
  /** Prefills the site when adding from the browser. */
  readonly initialUrl?: string | undefined;
  readonly onSaved?: (() => void) | undefined;
}

/**
 * Adds or edits a test login in T3 Code's own store. Test logins are for
 * test users of sites you develop; real accounts belong in Vault.
 */
export function TestLoginDialog(props: TestLoginDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        {/* Mounted per opening, so every form starts from its login. */}
        {props.open ? <TestLoginForm {...props} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function TestLoginForm(props: TestLoginDialogProps) {
  const { environmentId, onOpenChange, login, initialUrl, onSaved } = props;
  const save = useAtomCommand(credentialsEnvironment.saveTestLogin);
  const update = useAtomCommand(credentialsEnvironment.updateTestLogin);
  const reveal = useAtomCommand(credentialsEnvironment.revealTestLogin, { reportFailure: false });
  const [label, setLabel] = useState(login?.label ?? "");
  const [url, setUrl] = useState(login?.url ?? initialUrl ?? "");
  const [username, setUsername] = useState(login?.username ?? "");
  const [password, setPassword] = useState("");
  const [otpSecret, setOtpSecret] = useState("");
  const [saving, setSaving] = useState(false);

  // Editing loads the stored secrets into the form.
  useEffect(() => {
    if (!login) return;
    let cancelled = false;
    void reveal({ environmentId, input: { id: login.id } }).then((result) => {
      if (cancelled || result._tag === "Failure") return;
      setPassword(result.value.password);
      setOtpSecret(result.value.otpSecret ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, login, reveal]);

  const canSave = url.trim().length > 0 && username.trim().length > 0 && !saving;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    const result = login
      ? await update({
          environmentId,
          input: { id: login.id, label, url, username, password, otpSecret: otpSecret || null },
        })
      : await save({
          environmentId,
          input: {
            url,
            username,
            password,
            ...(label ? { label } : {}),
            ...(otpSecret ? { otpSecret } : {}),
          },
        });
    setSaving(false);
    if (result._tag === "Failure") return;
    toastManager.add({ type: "success", title: login ? "Test login updated" : "Test login saved" });
    onSaved?.();
    onOpenChange(false);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{login ? "Edit test login" : "Save a test login"}</DialogTitle>
        <DialogDescription>
          For test users of sites you develop. Agents can sign in with it without a prompt, so keep
          real accounts in Vault.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="test-login-url">Site</Label>
            <Input
              id="test-login-url"
              placeholder="http://myapp.test/login"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              autoFocus={!initialUrl}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="test-login-username">Username or email</Label>
            <Input
              id="test-login-username"
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoFocus={Boolean(initialUrl)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="test-login-password">Password</Label>
            <Input
              id="test-login-password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="test-login-label">Label (optional)</Label>
            <Input
              id="test-login-label"
              placeholder="admin, customer…"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="test-login-otp">One-time code secret (optional)</Label>
            <Input
              id="test-login-otp"
              placeholder="Base32 secret or otpauth:// link"
              autoComplete="off"
              value={otpSecret}
              onChange={(event) => setOtpSecret(event.target.value)}
            />
          </div>
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={!canSave}>
          {login ? "Save changes" : "Save test login"}
        </Button>
      </DialogFooter>
    </>
  );
}
