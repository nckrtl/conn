import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { OrbitNewInstanceSection } from "./CommandPaletteOrbitInstanceStep";

const PROJECT = {
  id: 5,
  slug: "nckrtl",
  name: "nckrtl.com",
  nodeName: "beast",
  domainSuffix: null,
};

describe("OrbitNewInstanceSection", () => {
  it("does not brighten a disabled plus on hover", async () => {
    await using _screen = await render(
      <OrbitNewInstanceSection
        project={PROJECT}
        selected={false}
        onCreate={vi.fn()}
        step={{
          field: { value: "", source: "none" },
          hint: {
            tone: "neutral",
            text: "Name the instance",
            plusEnabled: false,
            canCreate: false,
          },
          setTypedName: vi.fn(),
          markSubmitted: vi.fn(),
        }}
      />,
      // A plain section: no route reads.
      { router: false },
    );
    const plus = page.getByRole("button", { name: "Create instance" });
    await expect.element(plus).toBeDisabled();
    const look = () => {
      const style = getComputedStyle(plus.element());
      return { background: style.backgroundColor, color: style.color };
    };
    const before = look();
    await userEvent.hover(plus, { force: true });
    expect(plus.element().matches(":hover")).toBe(true);
    expect(look()).toEqual(before);
  });
});
