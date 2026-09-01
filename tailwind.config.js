/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src-react/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          900: '#0d1117',
          800: '#161b22',
          700: '#1c2230',
          600: '#21262d',
        },
        line: '#30363d',
        muted: '#8b949e',
        amber: {
          DEFAULT: '#ef9f27',
          soft: '#211a0e',
        },
        ok: '#3fb950',
        blue: {
          DEFAULT: '#58a6ff',
          soft: '#0d1b2e',
        },
        done: '#484f58',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '13': '13px',
      },
    },
  },
  plugins: [],
}
