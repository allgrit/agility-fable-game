// Темы ринга: время суток как визуальный пресет — цвета поля + оверлей + свет.
export const THEMES = {
  day: {
    outer: '#1d5c30', grass: '#2e7d43', stripeAlpha: 0.05,
    overlay: null, lights: false,
  },
  sunset: {
    outer: '#4a3a20', grass: '#5d7032', stripeAlpha: 0.06,
    overlay: 'rgba(255,140,50,0.14)', lights: false,
  },
  overcast: {
    outer: '#3a4a40', grass: '#4f6a55', stripeAlpha: 0.04,
    overlay: 'rgba(120,130,140,0.16)', lights: false,
  },
  night: {
    outer: '#0d1f28', grass: '#1c3a30', stripeAlpha: 0.05,
    overlay: 'rgba(10,16,40,0.30)', lights: true,
  },
};

// Тема по контексту: карьера — по этапу (день → закат → пасмурно → вечер),
// чемпионат мира — всегда вечерний стадион, трасса дня — от модификатора.
export function pickTheme({ mode, stage, modifier }) {
  if (mode === 'worldcup') return THEMES.night;
  if (mode === 'daily') {
    if (modifier === 'dusk') return THEMES.night;
    if (modifier === 'strict') return THEMES.overcast;
    return THEMES.sunset;
  }
  if (stage >= 5) return THEMES.night;
  if (stage === 4) return THEMES.overcast;
  if (stage === 3) return THEMES.sunset;
  return THEMES.day;
}
