import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";

// Tailwind's default settings, the same as the CDN script used (so `dark:` follows the system setting).
// Full paths, with special characters as [x] (a backslash would not survive), so the styles do not depend on the folder
const here = file => `${import.meta.dirname.replace(/[()[\]{}!*?+@]/g, "[$&]")}/${file}`;

export default {
  plugins: [tailwindcss({ content: [here("index.html"), here("src/**/*.{js,jsx}")] }), autoprefixer()], // the CDN script added the same prefixes
};
