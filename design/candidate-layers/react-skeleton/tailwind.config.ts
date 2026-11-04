import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    screens: { wide: "1181px" },
    extend: {
      colors: {
        ink: {
          DEFAULT: "#1b2b54",
          85: "#33406b",
          60: "#4f587b",
          40: "#838aa6",
          25: "#bfc2ce",
          12: "#dcdde3"
        },
        paper: {
          DEFAULT: "#edede7",
          hi: "#f6f6f1",
          2: "#e4e4dc"
        }
      },
      fontFamily: {
        display: ['"Noto Serif SC"', '"Source Han Serif SC"', '"Songti SC"', "SimSun", "serif"],
        sans: ['"Noto Sans SC"', '"PingFang SC"', '"Microsoft YaHei UI"', '"Hiragino Sans GB"', "sans-serif"]
      },
      borderRadius: { none: "0" }
    }
  },
  plugins: []
} satisfies Config;
