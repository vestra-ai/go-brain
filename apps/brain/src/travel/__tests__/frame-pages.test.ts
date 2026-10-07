import { describe, expect, it } from 'vitest';
import { isFramePage } from '../frame-pages.js';

describe('the pages Go may show a picture of', () => {
  it("ixigo's search, results and details pages, with the addresses the maps saw", () => {
    for (const url of [
      'https://www.ixigo.com/flights',
      'https://www.ixigo.com/hotels',
      'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form',
      'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form&stops=0&airlines=6E,AI&takeOff=EARLY_MORNING,MORNING&price=0,9000',
      'https://www.ixigo.com/search/result/train/NDLS/MAO/06112026//1/0/0/0/ALL',
      'https://www.ixigo.com/hotels/search/result?locationId=32&locationName=Goa&locationType=S&masterLocationId=48569&countryId=1&checkinDate=06112026&checkoutDate=09112026&adultCount=4&roomCount=1&childCount=0',
      'https://www.ixigo.com/hotels/1384544/details?locationId=1366415&locationName=Goa&locationType=S&checkinDate=06112026&checkoutDate=09112026&adultCount=4&roomCount=1&childCount=0&hotelInfoToken=true%7C3001%7C1&hName=Meritas%20Auberge',
      'https://www.ixigo.com/buses/bus_search/Mumbai/4/Goa/102/06-11-2026/O',
      'https://www.ixigo.com/trains/22656?orgn=NZM&dstn=MAO&departDate=2026-11-06&quota=GN',
    ]) {
      expect(isFramePage(url), url).toBe(true);
    }
  });

  it('never a booking, traveller, payment or sign-in page, even on a results address', () => {
    for (const url of [
      'https://www.ixigo.com/flight/booking/1044/1q4hf09hp?fareKey=DEL-GOI-6E5341-06112026&providers=1044',
      'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&adults=4&loginVisible=true',
      'https://www.ixigo.com/hotels/search/result?locationId=32&bookingId=7',
      'https://www.ixigo.com/payments/cbcc',
      'https://www.ixigo.com/hotels/checkout?hotelId=1384544&checkinDate=06112026&checkoutDate=09112026',
      'https://www.ixigo.com/account/farealerts/',
      'https://www.ixigo.com/trains/booking/traveller-details',
      'https://www.ixigo.com/hotels/1384544/details/review',
      'https://www.ixigo.com/support/group?p=app_search_form',
    ]) {
      expect(isFramePage(url), url).toBe(false);
    }
  });

  it('nothing outside those patterns, and nothing that only looks like ixigo', () => {
    for (const url of [
      'http://www.ixigo.com/search/result/flight?from=DEL&to=GOI',
      'https://ixigo.com/search/result/flight?from=DEL&to=GOI',
      'https://www.ixigo.com.evil.example/search/result/flight',
      'https://user:pw@www.ixigo.com/search/result/flight',
      'https://www.ixigo.com:8443/search/result/flight',
      'https://www.ixigo.com/offers',
      'https://www.ixigo.com/airlines/indigo-6e/web-checkin',
      'https://www.makemytrip.com/flight/search?itinerary=DEL-GOI-06/11/2026',
      'not a url',
    ]) {
      expect(isFramePage(url), url).toBe(false);
    }
  });
});
