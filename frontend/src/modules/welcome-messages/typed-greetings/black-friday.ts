import type { WelcomeDay } from './types';

const day: WelcomeDay = {
  id: 'black-friday',
  label: 'Black Friday',
  messages: [
    "Midnight on Black Friday, {name}. Carts already full.",   // 00:00
    "01:00 — sales are bleeding people, {name}.",              // 01:00
    "Late, {name}. Doorbusters are warming up.",               // 02:00
    "Three a.m. on Black Friday — lines forming, {name}.",     // 03:00
    "Pre-dawn shopping risk, {name}.",                         // 04:00
    "Early on Black Friday, {name}.",                          // 05:00
    "Doors opening somewhere, {name}.",                        // 06:00
    "Coffee, {name}. The carts are racing.",                   // 07:00
    "Morning of Black Friday, {name}.",                        // 08:00
    "Mid-morning, sites crashing, {name}.",                    // 09:00
    "Ten a.m., {name}. The credit cards are hot.",             // 10:00
    "Almost noon — discounts deepest, supposedly, {name}.",    // 11:00
    "Noon on Black Friday, {name}. Wallet in distress.",       // 12:00
    "Past noon, returns line forming, {name}.",                // 13:00
    "Afternoon, sales fatigue setting in, {name}.",            // 14:00
    "Three o'clock, {name}. Almost over.",                     // 15:00
    "Late afternoon, {name}. The mall is exhausted.",          // 16:00
    "Evening, {name}. Shipping confirmations rolling in.",     // 17:00
    "Dinner of regret, {name}.",                               // 18:00
    "Late evening sales sweep, {name}.",                       // 19:00
    "Eight p.m. on Black Friday, {name}.",                     // 20:00
    "Last sales pinging, {name}.",                             // 21:00
    "Almost done — Cyber Monday looms, {name}.",               // 22:00
    "Last hour of Black Friday, {name}. Survived.",            // 23:00
  ],
};

export default day;
