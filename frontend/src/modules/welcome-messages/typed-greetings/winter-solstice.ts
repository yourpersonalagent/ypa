import type { WelcomeDay } from './types';

const day: WelcomeDay = {
  id: 'winter-solstice',
  label: 'Winter Solstice',
  messages: [
    "Midnight on the longest night, {name}.",            // 00:00
    "01:00 — peak darkness somewhere, {name}.",          // 01:00
    "Late, {name}. The dark is winning.",                // 02:00
    "Three a.m., long night, {name}.",                   // 03:00
    "Pre-dawn, sun is late today, {name}.",              // 04:00
    "Early, but it's still night, {name}.",              // 05:00
    "Sunrise is late, {name}. Lamp on.",                 // 06:00
    "Morning slowly arrives, {name}.",                   // 07:00
    "Sun finally up, {name}.",                           // 08:00
    "Mid-morning, low sun, {name}.",                     // 09:00
    "Ten a.m. — sun barely above, {name}.",              // 10:00
    "Almost noon on the shortest day, {name}.",          // 11:00
    "Noon, {name}. The sun is brief today.",             // 12:00
    "Past noon — sunset already approaching, {name}.",   // 13:00
    "Afternoon, light fading fast, {name}.",             // 14:00
    "Three o'clock — already dimming, {name}.",          // 15:00
    "Sunset on the solstice, {name}.",                   // 16:00
    "Evening, {name}. Long night ahead.",                // 17:00
    "Candles, {name}. Solstice mood.",                   // 18:00
    "Dinner in the dark, {name}.",                       // 19:00
    "Eight p.m., {name}. Cozy hours.",                   // 20:00
    "Late evening, longest night, {name}.",              // 21:00
    "Deep into the dark, {name}.",                       // 22:00
    "Last hour of the shortest day, {name}.",            // 23:00
  ],
};

export default day;
