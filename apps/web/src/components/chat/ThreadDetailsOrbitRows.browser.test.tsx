import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

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

it("falls back to the slug, then the id, and links only a web URL", async () => {
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
    <ThreadDetailsOrbitRows
      orbitInstance={{ projectId: 7, instanceId: 41, url: "javascript:alert(1)" }}
      onOpenUrl={vi.fn()}
    />,
  );
  await expect.element(page.getByLabelText("Orbit Project Project 7")).toBeVisible();
  expect(page.getByRole("link").elements()).toHaveLength(0);
});

// The details card is --thread-details-panel-width (17.5rem) with px-2 section padding.
const PANEL_ROW_WIDTH = 280 - 16;

const renderAtPanelWidth = (instanceName: string) =>
  render(
    <div style={{ width: PANEL_ROW_WIDTH }}>
      <ThreadDetailsOrbitRows
        orbitInstance={{
          projectId: 7,
          instanceId: 1905,
          projectSlug: "create-bench",
          projectName: "create-bench",
          instanceName,
          nodeName: "beast",
          url: `http://${instanceName}.create-bench.test`,
        }}
        onOpenUrl={vi.fn()}
      />
    </div>,
    { router: false }, // A leaf row: no route reads it.
  );

const isClipped = (element: Element) => element.scrollWidth > element.clientWidth;

const isInside = (inner: Element, outer: Element) => {
  const a = inner.getBoundingClientRect();
  const b = outer.getBoundingClientRect();
  return a.width > 0 && a.left >= b.left - 0.5 && a.right <= b.right + 0.5;
};

it("shortens a long Instance name in the middle so the Node stays visible", async () => {
  const name = "list-the-files-here-62b311";
  await using screen = await renderAtPanelWidth(name);
  const row = screen.container.querySelector("[data-thread-panel-orbit-instance]")!;
  const head = row.querySelector("[data-orbit-instance-name-head]")!;
  const tail = row.querySelector("[data-orbit-instance-name-tail]")!;
  const node = row.querySelector("[data-orbit-node-name]")!;

  expect(head.textContent).toBe("list-the-files-here-");
  expect(isClipped(head)).toBe(true);
  expect(tail.textContent).toBe("62b311");
  expect(isClipped(tail)).toBe(false);
  expect(node.textContent).toBe(" · beast");
  expect(isClipped(node)).toBe(false);
  expect(isInside(tail, row)).toBe(true);
  expect(isInside(node, row)).toBe(true);
  // The Project keeps a visible start, cut at its end.
  const project = row.querySelector("[data-composer-label]")!;
  expect(project.getBoundingClientRect().width).toBeGreaterThan(24);

  await userEvent.hover(row.querySelector("[data-thread-panel-orbit-placement]")!);
  await expect
    .element(page.getByText(`Orbit Project create-bench, Instance ${name}, Node beast`).last())
    .toBeVisible();
});

it("shows a short Instance name in full", async () => {
  await using screen = await renderAtPanelWidth("t3-1a2b");
  const row = screen.container.querySelector("[data-thread-panel-orbit-instance]")!;
  const head = row.querySelector("[data-orbit-instance-name-head]")!;
  expect(row.querySelector("[data-thread-panel-orbit-placement]")!.textContent).toBe(
    "t3-1a2b · beast",
  );
  expect(isClipped(head)).toBe(false);
  expect(isClipped(row.querySelector("[data-composer-label] > span")!)).toBe(false);
  expect(isInside(row.querySelector("[data-orbit-node-name]")!, row)).toBe(true);
});

it("leaves out a missing or empty Instance or Node", async () => {
  const placement = (instanceName?: string, nodeName?: string) =>
    render(
      <ThreadDetailsOrbitRows
        orbitInstance={{
          projectId: 7,
          instanceId: 41,
          projectName: "create-bench",
          ...(instanceName === undefined ? {} : { instanceName }),
          ...(nodeName === undefined ? {} : { nodeName }),
        }}
        onOpenUrl={vi.fn()}
      />,
      { router: false }, // A leaf row: no route reads it.
    );
  const text = (container: HTMLElement) =>
    container.querySelector("[data-thread-panel-orbit-placement]")?.textContent ?? null;

  {
    await using screen = await placement(undefined, "beast");
    expect(text(screen.container)).toBe("beast");
  }
  {
    await using screen = await placement("t3-1a2b", "");
    expect(text(screen.container)).toBe("t3-1a2b");
  }
  {
    await using screen = await placement("", undefined);
    expect(text(screen.container)).toBeNull();
  }
});
