import type { WelcomeDay } from './types';
import defaultDay from './default';
import newYearsDay from './new-years-day';
import chineseNewYear from './chinese-new-year';
import valentinesDay from './valentines-day';
import internationalWomensDay from './international-womens-day';
import stPatricksDay from './st-patricks-day';
import aprilFoolsDay from './april-fools-day';
import earthDay from './earth-day';
import mayDay from './may-day';
import mothersDay from './mothers-day';
import fathersDay from './fathers-day';
import summerSolstice from './summer-solstice';
import friendshipDay from './friendship-day';
import halloween from './halloween';
import diwali from './diwali';
import thanksgiving from './thanksgiving';
import blackFriday from './black-friday';
import winterSolstice from './winter-solstice';
import christmasDay from './christmas-day';
import newYearsEve from './new-years-eve';

export type { WelcomeDay } from './types';

export const welcomeDays: readonly WelcomeDay[] = [
  defaultDay,
  newYearsDay,
  chineseNewYear,
  valentinesDay,
  internationalWomensDay,
  stPatricksDay,
  aprilFoolsDay,
  earthDay,
  mayDay,
  mothersDay,
  fathersDay,
  summerSolstice,
  friendshipDay,
  halloween,
  diwali,
  thanksgiving,
  blackFriday,
  winterSolstice,
  christmasDay,
  newYearsEve,
];

export const welcomeDaysById: Record<string, WelcomeDay> = Object.fromEntries(
  welcomeDays.map((d) => [d.id, d]),
);

export { defaultDay };
