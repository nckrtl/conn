import { createFileRoute } from "@tanstack/react-router";
import { PasswordsSettingsPanel } from "../components/settings/PasswordsSettings";

export const Route = createFileRoute("/_chat/settings/passwords")({
  component: PasswordsSettingsPanel,
});
