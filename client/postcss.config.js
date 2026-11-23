import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";

// The app's colours are named here and set in src/tailwind.css, once for each theme.
// Full paths, with special characters as [x] (a backslash would not survive), so the styles do not depend on the folder
const here = file => `${import.meta.dirname.replace(/[()[\]{}!*?+@]/g, "[$&]")}/${file}`;

const color = name => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  plugins: [
    tailwindcss({
      content: [here("index.html"), here("src/**/*.{js,jsx}")],
      theme: {
        extend: {
          colors: {
            ground: color("ground"),
            surface: color("surface"),
            raised: color("raised"),
            line: color("line"),
            ink: color("ink"),
            muted: color("muted"),
            accent: { DEFAULT: color("accent"), hover: color("accent-hover"), ink: color("accent-ink") },
            "on-accent": color("on-accent"),
            danger: { DEFAULT: color("danger"), hover: color("danger-hover") },
          },
          fontFamily: {
            sans: ['"Inter Variable"', "system-ui", "sans-serif"],
            display: ['"Space Grotesk Variable"', '"Inter Variable"', "system-ui", "sans-serif"],
          },
        },
      },
    }),
    autoprefixer(),
  ],
};
