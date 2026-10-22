/**
 * Monaco setup. Workers are bundled inline so they load from `file://` in the
 * packaged app without relying on a web server or blob CSP exceptions.
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker&inline';
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker&inline';
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker&inline';
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker&inline';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker&inline';

interface MonacoEnvironmentShape {
  getWorker(moduleId: string, label: string): Worker;
}

(self as unknown as { MonacoEnvironment: MonacoEnvironmentShape }).MonacoEnvironment = {
  getWorker(_moduleId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

monaco.editor.defineTheme('laie-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6b7c93', fontStyle: 'italic' },
    { token: 'keyword', foreground: '7aa2ff' },
    { token: 'string', foreground: '9ecb8a' },
    { token: 'number', foreground: 'e8b84b' },
    { token: 'type', foreground: '67d4c0' },
  ],
  colors: {
    'editor.background': '#0d1117',
    'editor.foreground': '#e7ecf3',
    'editorLineNumber.foreground': '#3d4b60',
    'editorLineNumber.activeForeground': '#93a1b3',
    'editor.selectionBackground': '#26406e',
    'editor.inactiveSelectionBackground': '#1d2f4d',
    'editor.lineHighlightBackground': '#111721',
    'editorCursor.foreground': '#7aa2ff',
    'editorIndentGuide.background1': '#1d2634',
    'editorWidget.background': '#161d28',
    'editorWidget.border': '#253040',
    'editorSuggestWidget.background': '#161d28',
    'editorSuggestWidget.selectedBackground': '#22304a',
    'scrollbarSlider.background': '#33415a66',
    'diffEditor.insertedTextBackground': '#3ecf8e22',
    'diffEditor.removedTextBackground': '#ff6b6b22',
  },
});

monaco.editor.defineTheme('laie-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#1c2532',
    'editorLineNumber.foreground': '#b3bfcd',
  },
});

loader.config({ monaco });

export { monaco };
