import cacheManager from '@server/lib/cache';
import ExternalAPI from '@server/api/externalapi';
import { getSettings } from '@server/lib/settings';

// Fanart.tv's music/artist images, keyed by MusicBrainz id -- the same
// provider Lidarr/Sonarr/Radarr use for artist/show art. Requires a personal
// API key (free, registered at https://fanart.tv/get-an-api-key/); when none
// is configured this API is simply not used (see getFanartTvArtistImage in
// music.ts, which checks the key before calling in).
// https://fanart.tv/api-docs/api-v3/#music

interface FanartTvArtistThumb {
  id: string;
  url: string;
  likes: string;
}

interface FanartTvArtistResponse {
  name: string;
  mbid_id: string;
  artistthumb?: FanartTvArtistThumb[];
  artistbackground?: FanartTvArtistThumb[];
  musiclogo?: FanartTvArtistThumb[];
  musicbanner?: FanartTvArtistThumb[];
}

export interface FanartTvArtistImages {
  thumbUrl?: string;
  backgroundUrl?: string;
}

class FanartTvAPI extends ExternalAPI {
  private apiKey: string;

  // apiKeyOverride lets the settings "Test" button validate a key the user
  // just typed, before it's saved -- getSettings() would still return the
  // old (or empty) one.
  constructor(apiKeyOverride?: string) {
    const settings = getSettings();
    const apiKey = apiKeyOverride ?? settings.metadataSettings.fanartTvApiKey;

    super(
      'https://webservice.fanart.tv/v3',
      { api_key: apiKey },
      {
        nodeCache: cacheManager.getCache('fanarttv').data,
        rateLimit: {
          maxRequests: 5,
          maxRPS: 5,
        },
      }
    );

    this.apiKey = apiKey;
  }

  public get hasApiKey(): boolean {
    return !!this.apiKey;
  }

  // A key-validity check for the settings "Test" button: Metallica is
  // guaranteed to exist on Fanart.tv, so anything other than a thrown
  // (non-404) error means the key itself is good.
  public test = async (): Promise<void> => {
    if (!this.apiKey) {
      throw new Error('No Fanart.tv API key configured');
    }
    await this.getArtistImages('65f4f0c5-ef9e-490c-aee3-909e7ae6b2ab');
  };

  /**
   * Best available artist thumbnail + background, or an empty object if
   * Fanart.tv has nothing for this artist (a very common, non-error outcome
   * for less-mainstream artists -- callers should fall back to a generic
   * placeholder rather than treat this as a failure).
   */
  public getArtistImages = async (
    mbid: string
  ): Promise<FanartTvArtistImages> => {
    if (!this.apiKey) {
      return {};
    }

    try {
      const data = await this.get<FanartTvArtistResponse>(
        `/music/${mbid}`,
        {},
        21600
      );

      return {
        thumbUrl: data.artistthumb?.[0]?.url,
        backgroundUrl: data.artistbackground?.[0]?.url,
      };
    } catch (e) {
      // Fanart.tv returns 404 for an artist it has no art for at all --
      // not an error worth logging on every miss, just an empty result.
      if (e.response?.status === 404) {
        return {};
      }

      throw new Error(
        `[FanartTV] Failed to retrieve artist images for ${mbid}: ${e.message}`,
        { cause: e }
      );
    }
  };
}

export default FanartTvAPI;
