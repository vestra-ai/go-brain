import { describe, expect, it } from 'vitest';
import { withoutLinks } from '../links.js';

describe('withoutLinks: no link in a chat line, whatever wrote it', () => {
  it("takes out the demo's 300-character ixigo address and closes up the sentence around it", () => {
    const page = `https://www.ixigo.com/hotels/54381/details?locationId=1366415&checkinDate=06112026&checkoutDate=09112026&adultCount=5&roomCount=3&hotelInfoToken=${'a'.repeat(160)}`;
    expect(withoutLinks(`Booking Saudades can't be done from here, so you'll have to book it yourselves on ixigo: ${page}. The vote closed with Saudades winning 3 to 0.`)).toBe(
      "Booking Saudades can't be done from here, so you'll have to book it yourselves on ixigo. The vote closed with Saudades winning 3 to 0.",
    );
  });

  it('a link at the end, in brackets, in angle brackets, or as a markdown link (whose words stay)', () => {
    expect(withoutLinks('Book it here: https://www.ixigo.com/hotels/1')).toBe('Book it here.');
    expect(withoutLinks('Villa Sol is lovely (https://www.ixigo.com/hotels/1).')).toBe('Villa Sol is lovely.');
    expect(withoutLinks('Photos: <https://www.ixigo.com/hotels/1>\nVote below.')).toBe('Photos.\nVote below.');
    expect(withoutLinks('See [Villa Sol](https://www.ixigo.com/hotels/1) for photos.')).toBe('See Villa Sol for photos.');
    expect(withoutLinks('Two: http://a.example/x and https://b.example/y?z=1, both gone.')).toBe('Two: and, both gone.');
  });

  it('leaves a line with no link exactly as it was, ixigo.com named as a site included', () => {
    for (const line of ['Searched ixigo.com for stays: three with a pool.', 'Rahul, tap Watch on the card.  Then I\'m logged in.', '6 to 9 Nov: done.']) {
      expect(withoutLinks(line)).toBe(line);
    }
  });

  it('a line that was only a link has nothing left', () => {
    expect(withoutLinks('https://www.ixigo.com/hotels/1')).toBe('');
  });
});
