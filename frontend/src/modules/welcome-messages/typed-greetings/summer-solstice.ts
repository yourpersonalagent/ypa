import type { WelcomeDay } from './types';

const day: WelcomeDay = {
  id: 'summer-solstice',
  label: 'Summer Solstice',
  messages: [
    "Midnight on the longest day, {name}.",                  // 00:00
    "01:00 — solstice still in progress, {name}.",           // 01:00
    "Late, {name}. The shortest night is nearly over.",      // 02:00
    "Three a.m. — sunrise is closer than usual, {name}.",    // 03:00
    "Pre-dawn, {name}. Light is impatient today.",           // 04:00
    "Sunrise already, {name}.",                              // 05:00
    "Morning of the longest day, {name}.",                   // 06:00
    "Coffee, {name}. The sun is committed today.",           // 07:00
    "Morning, {name}. Plenty of light coming.",              // 08:00
    "Mid-morning on the solstice, {name}.",                  // 09:00
    "Ten a.m., {name}. The day is showing off.",             // 10:00
    "Almost noon on the solstice, {name}.",                  // 11:00
    "Noon, {name}. The sun stands still.",                   // 12:00
    "Past noon, longest afternoon ahead, {name}.",           // 13:00
    "Afternoon of the solstice, {name}.",                    // 14:00
    "Three o'clock, sun still high, {name}.",                // 15:00
    "Late afternoon, plenty of daylight left, {name}.",      // 16:00
    "Five p.m., still bright, {name}.",                      // 17:00
    "Evening, sun won't quit, {name}.",                      // 18:00
    "Dinner with daylight, {name}.",                         // 19:00
    "Eight p.m. on the longest day, {name}.",                // 20:00
    "Late evening, sky still glowing, {name}.",              // 21:00
    "Almost dark, finally, {name}.",                         // 22:00
    "Last hour of the longest day, {name}.",                 // 23:00
  ],
};

export default day;
