import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

const languageFor = (path: string) =>
  /\.html?$/i.test(path) ? html() : /\.css$/i.test(path) ? css() : /\.(?:m?js|json)$/i.test(path) ? javascript({ jsx: false }) : [];

/** Colours from the page's tokens, so the editor follows light and dark like the rest of the UI. */
const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--color-card)", color: "var(--color-fg)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-gutters": { backgroundColor: "var(--color-panel)", color: "var(--color-muted)", borderRight: "1px solid var(--color-line)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--color-hover)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--color-fg)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--color-user)" },
});

/** Syntax colours from the same tokens, readable in light and dark. */
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--color-rune)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--color-ok)" },
  { tag: [tags.tagName, tags.typeName, tags.className], color: "var(--color-accent)" },
  { tag: [tags.attributeName, tags.propertyName], color: "var(--color-plan)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit], color: "var(--color-paid)" },
  { tag: [tags.comment, tags.meta, tags.documentMeta], color: "var(--color-muted)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: "var(--color-warn)" },
]);

/**
 * A CodeMirror editor for one file. `doc` replaces the text only when it differs from what the editor holds (a reload
 * from disk), so typing never fights the prop. Mod-S calls `onSave`.
 */
export const CodeEditor = ({
  path,
  doc,
  onChange,
  onSave,
}: {
  path: string;
  doc: string;
  onChange: (text: string) => void;
  onSave: () => void;
}) => {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const language = useRef(new Compartment());
  const label = useRef(new Compartment());
  // The latest callbacks, read by the editor's listeners, which are created once.
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once; path and doc changes are applied below.
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc,
        extensions: [
          basicSetup,
          theme,
          syntaxHighlighting(highlight),
          language.current.of(languageFor(path)),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                handlers.current.onSave();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
          }),
          label.current.of(EditorView.contentAttributes.of({ "aria-label": `Source of ${path}` })),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: [
        language.current.reconfigure(languageFor(path)),
        label.current.reconfigure(EditorView.contentAttributes.of({ "aria-label": `Source of ${path}` })),
      ],
    });
  }, [path]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== doc) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: doc } });
  }, [doc]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
};
