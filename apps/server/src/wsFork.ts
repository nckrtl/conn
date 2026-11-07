import { ForkWsRpcGroup, RpcScopeAuthorization, WS_METHODS } from "@t3tools/contracts";
import { RpcGroup } from "effect/rpc";
import * as Effect from "effect/Effect";

import * as AgentPanelBroker from "./panels/AgentPanelBroker.ts";
import * as AnnotationStore from "./annotations/AnnotationStore.ts";
import * as CredentialAutofill from "./credentials/CredentialAutofill.ts";
import * as TestLoginStore from "./credentials/TestLoginStore.ts";
import * as OrbitWorkspaceRegistrar from "./orbit/OrbitWorkspaceRegistrar.ts";
import { RpcInstrumentation } from "./observability/RpcInstrumentation.ts";
import * as ServerRestart from "./serverRestart.ts";

type ForkWsRpcTag = RpcGroup.Rpcs<typeof ForkWsRpcGroup>["_tag"];

export const forkWsRpcTags = [...ForkWsRpcGroup.requests.keys()] as [
  ForkWsRpcTag,
  ...ForkWsRpcTag[],
];

export const ForkServerWsRpcGroup =
  ForkWsRpcGroup.middleware(RpcScopeAuthorization).middleware(RpcInstrumentation);

export const makeForkWsHandlers = (services: {
  readonly serverRestart: ServerRestart.ServerRestart["Service"];
  readonly credentials: CredentialAutofill.CredentialAutofill["Service"];
  readonly testLogins: TestLoginStore.TestLoginStore["Service"];
  readonly annotations: AnnotationStore.AnnotationStore["Service"];
  readonly panels: AgentPanelBroker.AgentPanelBroker["Service"];
  readonly orbit: OrbitWorkspaceRegistrar.OrbitWorkspaceRegistrar["Service"];
}) =>
  ForkServerWsRpcGroup.of({
    [WS_METHODS.serverRestart]: () => services.serverRestart.restart,
    [WS_METHODS.credentialsListForSite]: (input) => services.credentials.listForSite(input),
    [WS_METHODS.credentialsFillForSite]: (input) => services.credentials.fillForSite(input),
    [WS_METHODS.testLoginsList]: () =>
      services.testLogins.list.pipe(
        Effect.map((logins) => ({ items: logins.map(TestLoginStore.summarizeTestLogin) })),
      ),
    [WS_METHODS.testLoginsSave]: (input) => services.testLogins.save(input, "user"),
    [WS_METHODS.testLoginsUpdate]: (input) => services.testLogins.update(input),
    [WS_METHODS.testLoginsRemove]: (input) => services.testLogins.remove(input.id),
    [WS_METHODS.testLoginsReveal]: (input) => services.testLogins.reveal(input.id),
    [WS_METHODS.annotationsSubscribe]: (input) => services.annotations.subscribe(input.projectId),
    [WS_METHODS.annotationsCreate]: (input) =>
      services.annotations
        .create(input.projectId, input.annotation)
        .pipe(Effect.map((annotation) => ({ annotation }))),
    [WS_METHODS.annotationsRemove]: (input) => services.annotations.remove(input),
    [WS_METHODS.agentPanelRequests]: (input) => services.panels.requests(input),
    [WS_METHODS.agentPanelRespond]: (input) => services.panels.respond(input),
    [WS_METHODS.orbitWorkspacesSubscribe]: () => services.orbit.subscribe,
    [WS_METHODS.orbitWorkspacesRegister]: (input) => services.orbit.register(input),
    [WS_METHODS.orbitWorkspacesRemove]: (input) => services.orbit.remove(input.threadId),
  });
