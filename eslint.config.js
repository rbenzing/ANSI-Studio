import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  { languageOptions: { globals: globals.node } },
  { files: ['public/**'], languageOptions: { globals: globals.browser } },
];
