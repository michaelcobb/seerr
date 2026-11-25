import cacheManager from '@server/lib/cache';
import ExternalAPI from '@server/api/externalapi';

// MusicBrainz asks anonymous (no API key) clients to stay at ~1 request per
// second and to send a descriptive User-Agent with a contact URL. See
// https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting
const MUSICBRAINZ_USER_AGENT =
  'Seerr-Lidarr-Patch/1.0 ( https://github.com/michaelcobb/seerr )';

// A failed call (a 503 from MusicBrainz's own throttling, say) is never
// cached by ExternalAPI.get() -- only a success is. Without this, every
// keystroke of a debounced search retries the network call again
// immediately, which just keeps hammering MusicBrainz while it's already
// telling us to back off, likely extending whatever throttle window we
// tripped. Remember a failure for a short window per (endpoint, query) and
// return an empty result straight away instead of retrying during it; the
// normal 6-hour success cache in get() covers the happy path, this only
// covers the unhappy one.
const FAILURE_BACKOFF_MS = 30_000;
const recentFailures = new Map<string, number>();

function isInBackoff(key: string): boolean {
  const until = recentFailures.get(key);
  if (!until) return false;
  if (Date.now() >= until) {
    recentFailures.delete(key);
    return false;
  }
  return true;
}

function recordFailure(key: string) {
  recentFailures.set(key, Date.now() + FAILURE_BACKOFF_MS);
}

export interface MusicBrainzArtist {
  id: string; // MusicBrainz ID (mbid)
  name: string;
  disambiguation?: string;
  type?: string; // Person | Group | Orchestra | Choir | Character | Other
  country?: string;
  score?: number;
  'life-span'?: { begin?: string; end?: string; ended?: boolean };
  // Only present when the request asked for inc=ratings -- a community
  // rating (0-5), not TMDB-style and far sparser: most artists have none.
  rating?: { value?: number; 'votes-count'?: number };
}

interface MusicBrainzArtistSearchResponse {
  created: string;
  count: number;
  offset: number;
  artists: MusicBrainzArtist[];
}

export interface MusicBrainzReleaseGroup {
  id: string;
  title: string;
  'primary-type'?: string;
  'first-release-date'?: string;
  'secondary-types'?: string[];
}

interface MusicBrainzArtistDetail extends MusicBrainzArtist {
  'release-groups'?: MusicBrainzReleaseGroup[];
}

// The artist embedded in an album/song search hit. MusicBrainz only gives
// us id/name/disambiguation here -- no type, country, or life-span, which
// is why an album/song match in music.ts's /search route can't fill in
// those fields the way a direct artist-name match can.
export interface MusicBrainzArtistCredit {
  name: string;
  artist: {
    id: string;
    name: string;
    disambiguation?: string;
  };
}

export interface MusicBrainzReleaseGroupSearchResult {
  id: string;
  title: string;
  'primary-type'?: string;
  'first-release-date'?: string;
  score?: number;
  'artist-credit'?: MusicBrainzArtistCredit[];
}

interface MusicBrainzReleaseGroupSearchResponse {
  created: string;
  count: number;
  offset: number;
  'release-groups': MusicBrainzReleaseGroupSearchResult[];
}

export interface MusicBrainzRecording {
  id: string;
  title: string;
  score?: number;
  'artist-credit'?: MusicBrainzArtistCredit[];
}

interface MusicBrainzRecordingSearchResponse {
  created: string;
  count: number;
  offset: number;
  recordings: MusicBrainzRecording[];
}

class MusicBrainzAPI extends ExternalAPI {
  constructor() {
    super(
      'https://musicbrainz.org/ws/2',
      { fmt: 'json' },
      {
        headers: {
          'User-Agent': MUSICBRAINZ_USER_AGENT,
        },
        nodeCache: cacheManager.getCache('musicbrainz').data,
        rateLimit: {
          maxRequests: 1,
          maxRPS: 1,
        },
      }
    );
  }

  // Capped at 20 (MusicBrainz's own default would be ~25) to match the page
  // size Seerr's TMDB movie/show search uses, and -- more importantly -- to
  // bound how many Fanart.tv image lookups music.ts's /search route fans out
  // to afterwards (one per returned artist, itself rate-limited to 5/sec).
  // MusicBrainz already returns artist search results ranked by its own
  // relevance score, so this keeps the top N most relevant, not an arbitrary
  // slice.
  public searchArtists = async (query: string): Promise<MusicBrainzArtist[]> => {
    if (!query.trim()) {
      return [];
    }

    const backoffKey = `artist:${query}`;
    if (isInBackoff(backoffKey)) {
      return [];
    }

    try {
      const data = await this.get<MusicBrainzArtistSearchResponse>(
        '/artist',
        { params: { query, limit: 20 } },
        21600
      );

      return data.artists;
    } catch (e) {
      recordFailure(backoffKey);
      throw new Error(
        `[MusicBrainz] Failed to search artists: ${e.message}`,
        { cause: e }
      );
    }
  };

  // Albums (release-groups), searched by title. Capped at 10 -- smaller than
  // searchArtists' 20 -- since this is a secondary signal layered on top of
  // the primary artist search (see music.ts's /search route), and every hit
  // here still needs its own Fanart.tv lookup once resolved down to an
  // artist.
  public searchReleaseGroups = async (
    query: string
  ): Promise<MusicBrainzReleaseGroupSearchResult[]> => {
    if (!query.trim()) {
      return [];
    }

    const backoffKey = `release-group:${query}`;
    if (isInBackoff(backoffKey)) {
      return [];
    }

    try {
      const data = await this.get<MusicBrainzReleaseGroupSearchResponse>(
        '/release-group',
        { params: { query, limit: 10 } },
        21600
      );

      return data['release-groups'];
    } catch (e) {
      recordFailure(backoffKey);
      throw new Error(
        `[MusicBrainz] Failed to search release groups: ${e.message}`,
        { cause: e }
      );
    }
  };

  // Songs (recordings), searched by title. See searchReleaseGroups for why
  // this is capped smaller than the primary artist search.
  public searchRecordings = async (
    query: string
  ): Promise<MusicBrainzRecording[]> => {
    if (!query.trim()) {
      return [];
    }

    const backoffKey = `recording:${query}`;
    if (isInBackoff(backoffKey)) {
      return [];
    }

    try {
      const data = await this.get<MusicBrainzRecordingSearchResponse>(
        '/recording',
        { params: { query, limit: 10 } },
        21600
      );

      return data.recordings;
    } catch (e) {
      recordFailure(backoffKey);
      throw new Error(
        `[MusicBrainz] Failed to search recordings: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getArtist = async (mbid: string): Promise<MusicBrainzArtistDetail> => {
    try {
      const data = await this.get<MusicBrainzArtistDetail>(
        `/artist/${mbid}`,
        { params: { inc: 'release-groups ratings' } },
        21600
      );

      return data;
    } catch (e) {
      throw new Error(
        `[MusicBrainz] Failed to retrieve artist ${mbid}: ${e.message}`,
        { cause: e }
      );
    }
  };
}

export default MusicBrainzAPI;

// MusicBrainz's 1-request/second anonymous-access courtesy rate is enforced
// by the rate limiter on an individual axios instance -- it has no idea
// about any other instance. `new MusicBrainzAPI()` per request (as
// music.ts's routes used to do) means every concurrent search mints its own
// limiter, each independently convinced it's the only thing talking to
// MusicBrainz, so the *real*, combined request rate from this server can run
// well past what MusicBrainz actually tolerates -- which is exactly what was
// producing live 503s from MusicBrainz once a single search started making
// three calls (artist/release-group/recording) instead of one. One shared,
// lazily-created instance for the whole process makes the 1/sec limiter mean
// what it says across every concurrent search, not just within one.
let sharedInstance: MusicBrainzAPI | undefined;
export function getMusicBrainzAPI(): MusicBrainzAPI {
  if (!sharedInstance) {
    sharedInstance = new MusicBrainzAPI();
  }
  return sharedInstance;
}
