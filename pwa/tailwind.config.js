/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          light: '#ffffff',
          dark: '#18181b',
        },
      },
    },
  },
  plugins: [],
}
