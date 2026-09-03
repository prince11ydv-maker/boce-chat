import type { Config } from "tailwindcss";

// BOCE Chat design tokens.
// Ink + paper base (not the cliché cream/terracotta pairing) with an
// electric-cobalt primary and warm-coral secondary — see README for the
// full design rationale.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#14141C",
        "ink-soft": "#5B5A66",
        paper: "#F6F5F1",
        "paper-dim": "#EDEBE3",
        line: "#E4E2DB",
        cobalt: {
          DEFAULT: "#3A36E0",
          dim: "#2A27A8",
          soft: "#EDECFC",
        },
        coral: {
          DEFAULT: "#FF6F59",
          soft: "#FFE7E1",
        },
        mint: {
          DEFAULT: "#1FAE7A",
          soft: "#DFF5EA",
        },
      },
      fontFamily: {
        display: ["var(--font-fraunces)", "Georgia", "serif"],
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      borderRadius: {
        chat: "18px",
      },
    },
  },
  plugins: [],
};

export default config;
