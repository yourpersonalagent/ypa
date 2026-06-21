import type { WelcomeDay } from './types';

const day: WelcomeDay = {
  id: 'christmas-day',
  label: 'Christmas Day',
  messages: [
    "Merry Christmas, {name}!",                              // 00:00
    "01:00 on Dec 25 — Santa is somewhere, {name}.",         // 01:00
    "Late hour on Christmas, {name}.",                       // 02:00
    "Three a.m. on Christmas — kids hour, {name}.",          // 03:00
    "Pre-dawn, presents waiting, {name}.",                   // 04:00
    "Early start, kids approaching, {name}.",                // 05:00
    "Morning of Christmas, {name}. Wrapping paper soon.",    // 06:00
    "Coffee, presents opening, {name}.",                     // 07:00
    "Christmas morning, {name}.",                            // 08:00
    "Mid-morning, paper everywhere, {name}.",                // 09:00
    "Ten a.m. on Christmas, {name}.",                        // 10:00
    "Almost noon, food preparing, {name}.",                  // 11:00
    "Noon on Christmas, {name}. Sun is brief.",              // 12:00
    "Past noon, the table is set, {name}.",                  // 13:00
    "Afternoon, family at the table, {name}.",               // 14:00
    "Three o'clock on Dec 25, {name}.",                      // 15:00
    "Late afternoon, Christmas, {name}.",                    // 16:00
    "Evening, {name}. Lights everywhere.",                   // 17:00
    "Dinner hour on Christmas, {name}.",                     // 18:00
    "Couch and pie, {name}.",                                // 19:00
    "Eight p.m. on Christmas, {name}.",                      // 20:00
    "Late evening, lights still on, {name}.",                // 21:00
    "Almost done with Christmas Day, {name}.",               // 22:00
    "Last hour of Christmas, {name}.",                       // 23:00
  ],
};

export default day;
