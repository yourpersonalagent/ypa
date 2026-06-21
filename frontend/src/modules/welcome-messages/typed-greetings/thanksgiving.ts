import type { WelcomeDay } from './types';

const day: WelcomeDay = {
  id: 'thanksgiving',
  label: 'Thanksgiving',
  messages: [
    "Midnight on Thanksgiving, {name}. Leftovers exist.",  // 00:00
    "01:00 — turkey dreams, {name}.",                      // 01:00
    "Late, {name}. Pie is at peak.",                       // 02:00
    "Three a.m. on Thanksgiving, {name}.",                 // 03:00
    "Pre-dawn turkey roasting somewhere, {name}.",         // 04:00
    "Early start, oven on, {name}.",                       // 05:00
    "Morning, {name}. Parade is on TV.",                   // 06:00
    "Coffee, {name}. The bird is starting.",               // 07:00
    "Morning of Thanksgiving, {name}.",                    // 08:00
    "Mid-morning, kitchen warming up, {name}.",            // 09:00
    "Ten a.m., {name}. The smells are arriving.",          // 10:00
    "Almost noon, plates loading, {name}.",                // 11:00
    "Noon, {name}. Hunger building.",                      // 12:00
    "Past noon, table setting time, {name}.",              // 13:00
    "Afternoon, family arriving, {name}.",                 // 14:00
    "Three o'clock — feast nears, {name}.",                // 15:00
    "Late afternoon, {name}. Carving up.",                 // 16:00
    "Dinner is starting somewhere, {name}.",               // 17:00
    "Plates full, {name}.",                                // 18:00
    "The table is loud, {name}.",                          // 19:00
    "Pie hour, {name}.",                                   // 20:00
    "Late evening, food coma, {name}.",                    // 21:00
    "Couch o'clock, {name}.",                              // 22:00
    "Last hour of Thanksgiving, {name}.",                  // 23:00
  ],
};

export default day;
