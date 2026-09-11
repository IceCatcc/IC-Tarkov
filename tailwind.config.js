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
      keyframes: {
        // 进行中卡片：左侧色条柔呼吸
        'bar-breathe': {
          '0%, 100%': { opacity: '0.45' },
          '50%': { opacity: '1' },
        },
        // 进行中状态药丸：向外扩散的蓝色光圈
        'pill-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(88, 166, 255, 0.5)' },
          '70%': { boxShadow: '0 0 0 6px rgba(88, 166, 255, 0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(88, 166, 255, 0)' },
        },
      },
      animation: {
        'bar-breathe': 'bar-breathe 2.4s ease-in-out infinite',
        'pill-ring': 'pill-ring 2.4s ease-out infinite',
      },
    },
  },
  plugins: [],
}
