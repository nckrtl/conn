import type {
  CredentialField,
  CredentialFillStatus,
  PreviewTabId,
  ScopedThreadRef,
  SiteCredentialOption,
} from "@t3tools/contracts";
import { KeyRoundIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useVaultLogins } from "./useVaultLogins";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { credentialsEnvironment } from "~/state/credentials";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { hostOf, originOf } from "./credentialApproval";
import {
  beginCredentialContinuation,
  continuationMatches,
  continuationFields,
  type CredentialContinuation,
} from "./credentialContinuation";
import { submitCredentialStep } from "./credentialSubmit";
import { TestLoginDialog } from "./TestLoginDialog";
import { CredentialInlineSuggestions } from "./CredentialInlineSuggestions";
import {
  EMPTY_PAGE_FIELDS,
  type CredentialPageFields,
  detectCredentialPageFields,
} from "./credentialPageFields";

const FILL_FAILURES: Record<string, string> = {
  origin_mismatch: "The page is not on this login's saved site.",
  tab_unavailable: "The tab has no page loaded.",
  field_not_found: "No matching field is visible on the page.",
  not_editable: "The field cannot take this value.",
  insert_failed: "The page did not accept the value.",
  no_value: "This login has no value for that field.",
  provider_unavailable: "The password manager is unavailable. Unlock it and try again.",
  item_not_found: "The password manager no longer offers this login for this site.",
  denied: "Vault was not unlocked. Unlock it and try again.",
};

/**
 * Fills a Vault login on this desktop, one field at a time. Vault reads the
 * value and the desktop inserts it into the tab; neither the renderer nor the
 * environment sees it. Null when this desktop build cannot fill from Vault.
 */
async function fillFromVault(
  runtimeTabId: string,
  itemId: string,
  expectedOrigin: string,
  fields: ReadonlyArray<CredentialField>,
): Promise<ReadonlyArray<{ field: CredentialField; status: CredentialFillStatus }> | null> {
  const vaultFill = window.desktopBridge?.vaultFill;
  if (!vaultFill) return null;
  const results: Array<{ field: CredentialField; status: CredentialFillStatus }> = [];
  for (const field of fields) {
    const filled = await vaultFill({ tabId: runtimeTabId, itemId, field, expectedOrigin });
    results.push({ field, status: filled.status });
  }
  return results;
}

/** The fields one click fills, from what the page shows. */
function fieldsToFill(page: CredentialPageFields): ReadonlyArray<CredentialField> {
  if (page.password) return page.username ? ["username", "password"] : ["password"];
  if (page.otp) return ["otp"];
  if (page.username) return ["username"];
  return [];
}

/**
 * The key in the browser's address bar. Lights up on a sign-in page that has
 * saved logins and fills the one the user picks, without an approval prompt.
 */
export function CredentialKeyButton(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: PreviewTabId;
  readonly runtimeTabId: string;
  readonly pageUrl: string | null;
  readonly loading: boolean;
  readonly visible?: boolean;
}) {
  const { threadRef, tabId, runtimeTabId, pageUrl, loading } = props;
  const { environmentId, threadId } = threadRef;
  const origin = originOf(pageUrl);
  // Detection result for one URL; a different or loading page reads as none.
  const [saveOpen, setSaveOpen] = useState(false);
  const [detected, setDetected] = useState<{
    readonly url: string;
    readonly fields: CredentialPageFields;
  } | null>(null);
  const sites = useEnvironmentQuery(
    origin === null
      ? null
      : credentialsEnvironment.listForSite({
          environmentId: threadRef.environmentId,
          input: { url: origin },
        }),
  );
  const fill = useAtomCommand(credentialsEnvironment.fillForSite, { reportFailure: false });
  const page = !loading && detected?.url === pageUrl ? detected.fields : EMPTY_PAGE_FIELDS;
  const vault = useVaultLogins(page.any && origin?.startsWith("https://") ? pageUrl : null);
  const items: readonly SiteCredentialOption[] = [
    ...(sites.data?.items ?? []).filter((item) => item.source === "test"),
    ...(vault.result?.items ?? []),
  ];
  const [filling, setFilling] = useState(false);
  const fillingRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const unlockingRef = useRef(false);
  const [continuation, setContinuation] = useState<CredentialContinuation | null>(null);
  const currentContext = useRef({ origin, runtimeTabId });
  useEffect(() => {
    currentContext.current = { origin, runtimeTabId };
  }, [origin, runtimeTabId]);

  const detect = useCallback(
    (url: string) =>
      detectCredentialPageFields(runtimeTabId).then((fields) => setDetected({ url, fields })),
    [runtimeTabId, setDetected],
  );

  // Check after each load, and once more shortly after: many sign-in forms
  // render after the load event.
  useEffect(() => {
    if (loading || pageUrl === null) return;
    void detect(pageUrl);
    const later = window.setTimeout(() => void detect(pageUrl), 1200);
    return () => window.clearTimeout(later);
  }, [detect, loading, pageUrl]);

  const fields = fieldsToFill(page);
  const ready = page.any && items.length > 0;
  const label = ready ? "Fill a saved login" : "Saved logins";

  const fillLogin = useCallback(
    async (
      item: SiteCredentialOption,
      requestedFields: ReadonlyArray<CredentialField>,
      automatic = false,
    ) => {
      const { id: itemId, title } = item;
      if (!origin || requestedFields.length === 0 || fillingRef.current) return;
      fillingRef.current = true;
      setFilling(true);
      try {
        const results = await (item.source === "vault"
          ? fillFromVault(runtimeTabId, itemId, origin, requestedFields)
          : fill({
              environmentId,
              input: {
                environmentId,
                threadId,
                tabId,
                itemId,
                source: item.source,
                fields: [...requestedFields],
              },
            }).then((result) => (result._tag === "Failure" ? null : result.value.results)));
        if (results === null) {
          setContinuation(null);
          toastManager.add({ type: "error", title: `Could not fill “${title}”` });
          return;
        }
        const failed = results.find(
          (entry) =>
            entry.status !== "filled" &&
            // A transitioning form can disappear between detection and fill.
            // Keep polling; only a successful fill consumes the step.
            entry.status !== "field_not_found" &&
            entry.status !== "not_editable",
        );
        if (failed) {
          setContinuation(null);
          toastManager.add({
            type: "warning",
            title: `Could not fill “${title}”`,
            // Vault also returns item_not_found when the selected login has
            // no OTP seed. Do not present that as a definite site mismatch.
            description:
              item.source === "vault" &&
              failed.field === "otp" &&
              (failed.status === "item_not_found" || failed.status === "no_value")
                ? "Vault could not provide a verification code. Check that this login has a code configured in Vault and matches this site."
                : (FILL_FAILURES[failed.status] ?? "The fill did not finish."),
          });
        } else if (
          currentContext.current.origin === origin &&
          currentContext.current.runtimeTabId === runtimeTabId
        ) {
          const completed = results
            .filter((entry) => entry.status === "filled")
            .map((entry) => entry.field);
          setContinuation((current) => {
            if (
              automatic &&
              (!current ||
                current.item.id !== item.id ||
                current.item.source !== item.source ||
                !continuationMatches(current, runtimeTabId, origin))
            )
              return current;
            const session =
              automatic && current
                ? current
                : beginCredentialContinuation(item, runtimeTabId, origin, []);
            if (automatic && completed.length === 0) return session;
            return {
              ...session,
              attempted: new Set([...session.attempted, ...completed]),
              pendingSubmit: completed.includes("otp")
                ? "otp"
                : completed.includes("password")
                  ? "password"
                  : completed.includes("username")
                    ? "username"
                    : session.pendingSubmit,
            };
          });
        }
      } finally {
        fillingRef.current = false;
        setFilling(false);
      }
    },
    [fill, origin, runtimeTabId, tabId, environmentId, threadId, setContinuation, setFilling],
  );

  // Only a user-selected login arms this short-lived continuation. It survives
  // same-site navigation and SPA steps, and stores no credential values.
  useEffect(() => {
    if (!continuation) return;
    // Navigation can temporarily have no committed URL. Wait for the next
    // document before checking its origin; no fill runs while it is loading.
    if (loading) return;
    if (
      (continuation.attempted.has("otp") && !continuation.pendingSubmit) ||
      !continuationMatches(continuation, runtimeTabId, origin)
    ) {
      const clear = setTimeout(() => setContinuation(null), 0);
      return () => clearTimeout(clear);
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (cancelled) return;
      if (!continuationMatches(continuation, runtimeTabId, currentContext.current.origin)) {
        setContinuation(null);
        return;
      }
      try {
        if (!fillingRef.current && document.visibilityState !== "hidden") {
          let nextPage = await detectCredentialPageFields(runtimeTabId);
          if (cancelled) return;
          if (pageUrl) setDetected({ url: pageUrl, fields: nextPage });
          let nextFields = continuationFields(continuation, nextPage);
          if (nextFields.length > 0 && continuation.item.source === "vault") {
            // A lock or removed login ends continuation instead of raising an
            // unsolicited native unlock prompt on the next step.
            const available = await window.desktopBridge?.vaultLogins?.({
              action: "list",
              url: pageUrl ?? continuation.origin,
              allowUnlock: false,
            });
            if (cancelled) return;
            if (
              available?.status !== "ok" ||
              !available.items.some((item) => item.id === continuation.item.id)
            ) {
              setContinuation(null);
              return;
            }
            nextPage = await detectCredentialPageFields(runtimeTabId);
            nextFields = continuationFields(continuation, nextPage);
          }
          if (cancelled) return;
          if (nextFields.length > 0) {
            await fillLogin(continuation.item, nextFields, true);
            return;
          }
          if (continuation.pendingSubmit) {
            fillingRef.current = true;
            try {
              const submitted = await submitCredentialStep(
                runtimeTabId,
                continuation.pendingSubmit,
                continuation.origin,
                continuation.id,
              );
              if (!cancelled && submitted !== "waiting") {
                setContinuation((current) =>
                  current === continuation ? { ...current, pendingSubmit: undefined } : current,
                );
              }
            } finally {
              fillingRef.current = false;
            }
          }
        }
      } catch {
        if (!cancelled) setContinuation(null);
      } finally {
        if (!cancelled) timer = setTimeout(() => void check(), 750);
      }
    };
    void check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [continuation, fillLogin, loading, origin, pageUrl, runtimeTabId]);

  const unlockVault = async () => {
    unlockingRef.current = true;
    try {
      await vault.refresh(true);
    } finally {
      unlockingRef.current = false;
    }
  };

  if (origin === null) return null;

  const testItems = items.filter((item) => item.source === "test");
  const vaultItems = items.filter((item) => item.source === "vault");
  const loginItem = (item: (typeof items)[number]) => (
    <MenuItem
      key={`${item.source}:${item.id}`}
      disabled={fields.length === 0 || filling}
      onClick={() => void fillLogin(item, fields)}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{item.title}</span>
        {item.username && item.username !== item.title ? (
          <span className="truncate text-muted-foreground text-xs">{item.username}</span>
        ) : null}
      </span>
    </MenuItem>
  );

  return (
    <>
      <CredentialInlineSuggestions
        runtimeTabId={runtimeTabId}
        origin={origin}
        enabled={props.visible !== false && !loading && !menuOpen && !filling && !continuation}
        items={items}
        vault={vault}
        onFocus={() => {
          if (pageUrl) void detect(pageUrl);
          if (!vault.busy) void vault.refresh();
        }}
        onChoose={async (item) => {
          const current = await detectCredentialPageFields(runtimeTabId);
          await fillLogin(item, fieldsToFill(current));
        }}
        onUnlock={unlockVault}
      />
      {page.any || items.length > 0 ? (
        <Menu
          open={menuOpen}
          onOpenChange={(open, details) => {
            // Native unlock and refreshing menu rows can temporarily move focus.
            // Escape and outside clicks still dismiss the menu normally.
            const lostNativeFocus =
              details.event instanceof FocusEvent
                ? details.event.relatedTarget === null
                : !document.hasFocus();
            if (
              !open &&
              details.reason === "focus-out" &&
              (unlockingRef.current || vault.busy || lostNativeFocus)
            ) {
              details.cancel();
              return;
            }
            setMenuOpen(open);
            if (open && pageUrl) {
              void detect(pageUrl);
              if (!vault.busy) void vault.refresh();
            }
          }}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button variant="ghost" size="icon-xs" type="button" aria-label={label} />
                  }
                />
              }
            >
              {filling ? (
                <Spinner />
              ) : (
                <KeyRoundIcon className={ready ? "text-primary" : undefined} />
              )}
            </TooltipTrigger>
            <TooltipPopup>{label}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end" sideOffset={6}>
            {vault.supported && page.any && origin.startsWith("https://") && (
              <>
                <MenuGroup>
                  <MenuGroupLabel>Vault · this Mac</MenuGroupLabel>
                  {vaultItems.map(loginItem)}
                  {vault.busy && (
                    <MenuItem disabled>
                      <Spinner data-icon="inline-start" /> Checking Vault…
                    </MenuItem>
                  )}
                  {vault.result?.status === "locked" && (
                    <MenuItem
                      disabled={vault.busy}
                      closeOnClick={false}
                      onClick={() => void unlockVault()}
                    >
                      Unlock Vault…
                    </MenuItem>
                  )}
                  {vault.result?.status === "error" && (
                    <MenuItem
                      disabled={vault.busy}
                      closeOnClick={false}
                      onClick={() => void unlockVault()}
                    >
                      Retry Vault…
                    </MenuItem>
                  )}
                  {!vault.busy && vault.result?.status === "unavailable" && (
                    <MenuItem disabled>Vault is not installed</MenuItem>
                  )}
                  {!vault.busy && vault.result?.status === "ok" && vaultItems.length === 0 && (
                    <MenuItem disabled>No Vault logins for this site</MenuItem>
                  )}
                </MenuGroup>
                <MenuSeparator />
              </>
            )}
            {sites.error && !sites.data ? (
              // An older T3 server answers with an unknown-request error.
              <MenuItem disabled>This thread's server can't look up test logins</MenuItem>
            ) : (
              <>
                <MenuGroup>
                  <MenuGroupLabel className="max-w-72">
                    <span className="block truncate">Test logins · {hostOf(origin)}</span>
                  </MenuGroupLabel>
                  {sites.data?.unavailable ? (
                    <MenuItem disabled>Test logins are unavailable</MenuItem>
                  ) : (
                    testItems.map(loginItem)
                  )}
                  <MenuItem onClick={() => setSaveOpen(true)}>Save a test login…</MenuItem>
                </MenuGroup>
                {items.length > 0 && fields.length === 0 ? (
                  <MenuGroup>
                    <MenuGroupLabel>No sign-in field on this page</MenuGroupLabel>
                  </MenuGroup>
                ) : null}
                {items.length > 0 && fields[0] === "otp" ? (
                  <MenuGroup>
                    <MenuGroupLabel>Fills the one-time code</MenuGroupLabel>
                  </MenuGroup>
                ) : null}
              </>
            )}
          </MenuPopup>
        </Menu>
      ) : null}
      <TestLoginDialog
        environmentId={threadRef.environmentId}
        open={saveOpen}
        onOpenChange={setSaveOpen}
        initialUrl={pageUrl ?? undefined}
        onSaved={() => sites.refresh()}
      />
    </>
  );
}
