import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ThreadDetailsOrbitRows } from "./ThreadDetailsOrbitRows";

it("shows the Orbit Project, Instance, Node and a URL link that opens in Conn", async () => {
  const onOpenUrl = vi.fn();
  await using _screen = await render(
    <ThreadDetailsOrbitRows
      orbitInstance={{
        projectId: 7,
        instanceId: 41,
        projectSlug: "hauzer",
        projectName: "Hauzer App",
        instanceName: "t3-1a2b3c4d",
        nodeName: "beast",
        url: "https://t3-1a2b3c4d.hauzer.test",
      }}
      onOpenUrl={onOpenUrl}
    />,
    { router: false }, // A leaf row: no route reads it.
  );

  await expect
    .element(page.getByLabelText("Orbit Project Hauzer App, Instance t3-1a2b3c4d, Node beast"))
    .toHaveTextContent("Hauzer Appt3-1a2b3c4d · beast");
  await userEvent.click(page.getByRole("link", { name: "Open https://t3-1a2b3c4d.hauzer.test" }));
  expect(onOpenUrl).toHaveBeenCalledWith("https://t3-1a2b3c4d.hauzer.test", expect.anything());
});

it("falls back to the slug, then the id, and shows no link without a URL", async () => {
  await using screen = await render(
    <ThreadDetailsOrbitRows
      orbitInstance={{ projectId: 7, instanceId: 41, projectSlug: "hauzer" }}
      onOpenUrl={vi.fn()}
    />,
    { router: false }, // A leaf row: no route reads it.
  );
  await expect.element(page.getByLabelText("Orbit Project hauzer")).toBeVisible();
  expect(page.getByRole("link").elements()).toHaveLength(0);

  await screen.rerender(
    <ThreadDetailsOrbitRows orbitInstance={{ projectId: 7, instanceId: 41 }} onOpenUrl={vi.fn()} />,
  );
  await expect.element(page.getByLabelText("Orbit Project Project 7")).toBeVisible();
});
