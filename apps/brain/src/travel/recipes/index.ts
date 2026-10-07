/** The four ixigo.com recipes, one per kind of search. */
import type { TravelKind } from '../travel.js';
import { buses } from './buses.js';
import { flights } from './flights.js';
import type { Recipe } from './recipe.js';
import { stays } from './stays.js';
import { trains } from './trains.js';

export const RECIPES: { [K in TravelKind]: Recipe<any> } = { flights, stays, trains, buses };
