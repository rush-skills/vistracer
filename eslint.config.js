import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      react.configs.flat.recommended,
      react.configs.flat["jsx-runtime"],
      // react-hooks stays on 6.x: 7.x adds the React Compiler rules to this
      // preset, and the app does not use the React Compiler.
      reactHooks.configs["flat/recommended"]
    ],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.renderer.json"],
        tsconfigRootDir: import.meta.dirname
      },
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    settings: {
      react: {
        version: "detect"
      }
    },
    rules: {
      "react/react-in-jsx-scope": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "react/prop-types": "off"
    }
  },
  prettier
);
