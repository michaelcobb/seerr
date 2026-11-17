import cacheManager from '@server/lib/cache';
import ExternalAPI from '@server/api/externalapi';

// MusicBrainz asks anonymous (no API key) clients to stay at ~1 request per
// second and to send a descriptive User-Agent with a contact URL. See
// https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting
const MUSICBRAINZ_USER_AGENT =
  'Seerr-Lidarr-Patch/1.0 ( https://github.com/michaelcobb/seerr )';

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

    try {
      const data = await this.get<MusicBrainzArtistSearchResponse>(
        '/artist',
        { params: { query, limit: 20 } },
        21600
      );

      return data.artists;
    } catch (e) {
      throw new Error(
        `[MusicBrainz] Failed to search artists: ${e.message}`,
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
