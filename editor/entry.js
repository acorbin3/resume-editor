// Bundled to public/vendor/editor.js by `npm run build:editor`.
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment, StateEffect, StateField } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { setDiagnostics } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";

// Brief highlight on a line after jumping to it from the PDF.
const flashEffect = StateEffect.define();
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        deco = e.value == null ? Decoration.none : Decoration.set([Decoration.line({ class: "cm-flash-line" }).range(e.value)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const baseTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: "1.5" },
  ".cm-flash-line": { backgroundColor: "rgba(255, 200, 0, 0.35)", transition: "background-color 0.6s" },
});

export function createEditor({ parent, onSave, onChange, onDoubleClick }) {
  const theme = new Compartment();
  const dark = window.matchMedia("(prefers-color-scheme: dark)");

  const extensions = () => [
    basicSetup,
    StreamLanguage.define(stex),
    EditorView.lineWrapping,
    baseTheme,
    flashField,
    theme.of(dark.matches ? oneDark : []),
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          onSave?.();
          return true;
        },
      },
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange?.();
    }),
    EditorView.domEventHandlers({
      dblclick(event, v) {
        const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos != null) onDoubleClick?.(v.state.doc.lineAt(pos).number);
        return false; // keep the normal word selection
      },
    }),
  ];

  const view = new EditorView({ parent, state: EditorState.create({ doc: "", extensions: extensions() }) });

  dark.addEventListener("change", (e) => view.dispatch({ effects: theme.reconfigure(e.matches ? oneDark : []) }));

  let flashTimer;
  return {
    view,
    getValue: () => view.state.doc.toString(),
    // Load a new document with a fresh undo history (undo never goes past the load).
    setValue(text) {
      view.setState(EditorState.create({ doc: text, extensions: extensions() }));
    },
    // Scroll a 1-based line into the middle of the view and flash it. With a word,
    // the word is selected; without one the cursor goes to the start of the line.
    goToLine(lineNo, word) {
      const line = view.state.doc.line(Math.min(Math.max(lineNo, 1), view.state.doc.lines));
      const col = word ? line.text.indexOf(word) : -1;
      view.dispatch({
        selection: col >= 0 ? { anchor: line.from + col, head: line.from + col + word.length } : { anchor: line.from },
        effects: [EditorView.scrollIntoView(line.from, { y: "center" }), flashEffect.of(line.from)],
      });
      view.focus();
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), 1400);
    },
    setError(lineNo, message) {
      const line = view.state.doc.line(Math.min(Math.max(lineNo, 1), view.state.doc.lines));
      view.dispatch(setDiagnostics(view.state, [{ from: line.from, to: line.to, severity: "error", message }]));
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    },
    clearErrors() {
      view.dispatch(setDiagnostics(view.state, []));
    },
  };
}
