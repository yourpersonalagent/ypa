import type { WelcomeDay } from './types';

const day: WelcomeDay = {
  id: 'earth-day',
  label: 'Earth Day',
  messages: [
    "Midnight on Earth Day, {name}. Quietly spinning.",  // 00:00
    "01:00 — the planet is fine, briefly, {name}.",      // 01:00
    "Late on Earth Day, {name}.",                        // 02:00
    "Three a.m. — owls are working, {name}.",            // 03:00
    "Pre-dawn, {name}. Birds are loading.",              // 04:00
    "Early Earth Day, {name}.",                          // 05:00
    "Sunrise, {name}. Same star, again.",                // 06:00
    "Morning of Earth Day, {name}.",                     // 07:00
    "Coffee, {name}. The grounds compost beautifully.",  // 08:00
    "Mid-morning on Earth Day, {name}.",                 // 09:00
    "Ten a.m., {name}. The trees noticed nothing.",      // 10:00
    "Almost noon on Apr 22, {name}.",                    // 11:00
    "Noon, {name}. The sun is doing the work.",          // 12:00
    "Past noon, {name}.",                                // 13:00
    "Afternoon, {name}. Walk somewhere maybe.",          // 14:00
    "Three o'clock on Earth Day, {name}.",               // 15:00
    "Late afternoon, {name}. The sky is nice today.",    // 16:00
    "Evening, {name}.",                                  // 17:00
    "Sunset, {name}. The view is included.",             // 18:00
    "Dinner — hopefully local, {name}.",                 // 19:00
    "Eight p.m. on Earth Day, {name}.",                  // 20:00
    "Late evening, planet still spinning, {name}.",      // 21:00
    "Almost done with Earth Day, {name}.",               // 22:00
    "Last hour of Apr 22, {name}.",                      // 23:00
  ],
};

export default day;
