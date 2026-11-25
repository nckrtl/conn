import { useMemo } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { common, createLowlight } from "lowlight";

const grammars = createLowlight(common);
grammars.registerAlias({ rust: ["rs"], typescript: ["tsx"], javascript: ["jsx"], bash: ["zsh"] });

export default function HighlightedCode({ language, code }: { language: string; code: string }) {
  return useMemo(() => {
    if (!grammars.registered(language)) return code;
    return toJsxRuntime(grammars.highlight(language, code), { Fragment, jsx, jsxs });
  }, [code, language]);
}
