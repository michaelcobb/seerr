import ServarrBase from './base';

/**
 * Lidarr API client.
 *
 * Lidarr's v1 API exposes the same system/status, qualityProfile, rootfolder,
 * tag and command endpoints that Radarr/Sonarr expose on v3, so all of that
 * is already provided by ServarrBase. This class adds the artist-specific
 * endpoints (metadata profiles, lookup-by-mbid, add artist) that back the
 * music request flow: Seerr resolves an artist on MusicBrainz, then asks
 * Lidarr to look up and add that same artist (matched by MusicBrainz ID) and
 * start monitoring/searching for it, the same way Radarr/Sonarr requests add
 * and monitor a movie/show.
 */

export interface LidarrMetadataProfile {
  id: number;
  name: string;
}

export interface LidarrArtistLookupResult {
  artistName: string;
  foreignArtistId: string; // MusicBrainz artist id
  overview?: string;
  disambiguation?: string;
  genres?: string[];
  images?: { coverType: string; url: string }[];
  // present only once the artist already exists in Lidarr's own DB
  id?: number;
  monitored?: boolean;
}

export interface LidarrArtist extends LidarrArtistLookupResult {
  id: number;
  monitored: boolean;
  path?: string;
  qualityProfileId: number;
  metadataProfileId: number;
}

class LidarrAPI extends ServarrBase<Record<string, never>> {
  constructor({ url, apiKey }: { url: string; apiKey: string }) {
    super({ url, apiKey, cacheName: 'lidarr', apiName: 'Lidarr' });
  }

  public getMetadataProfiles = async (): Promise<LidarrMetadataProfile[]> => {
    try {
      const data = await this.getRolling<LidarrMetadataProfile[]>(
        '/metadataprofile',
        undefined,
        3600
      );

      return data;
    } catch (e) {
      throw new Error(
        `[Lidarr] Failed to retrieve metadata profiles: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getArtists = async (): Promise<LidarrArtist[]> => {
    try {
      // Not cached with a TTL: callers use this right before deciding whether
      // to add an artist, and a stale "not yet added" answer would let a
      // request silently no-op against an artist Lidarr already has.
      const response = await this.axios.get<LidarrArtist[]>('/artist');

      return response.data;
    } catch (e) {
      throw new Error(
        `[Lidarr] Failed to retrieve artists: ${e.message}`,
        { cause: e }
      );
    }
  };

  /**
   * Looks up an artist by MusicBrainz ID via Lidarr's own metadata-provider
   * lookup (Lidarr accepts `lidarr:<mbid>` as a search term for an exact
   * match). Returns undefined if Lidarr's metadata provider has nothing for
   * that id.
   */
  public lookupArtistByMbid = async (
    mbid: string
  ): Promise<LidarrArtistLookupResult | undefined> => {
    try {
      const response = await this.axios.get<LidarrArtistLookupResult[]>(
        '/artist/lookup',
        { params: { term: `lidarr:${mbid}` } }
      );

      return response.data[0];
    } catch (e) {
      throw new Error(
        `[Lidarr] Failed to look up artist ${mbid}: ${e.message}`,
        { cause: e }
      );
    }
  };

  public addArtist = async (options: {
    artist: LidarrArtistLookupResult;
    qualityProfileId: number;
    metadataProfileId: number;
    rootFolderPath: string;
    tags?: number[];
  }): Promise<LidarrArtist> => {
    try {
      const response = await this.axios.post<LidarrArtist>('/artist', {
        ...options.artist,
        qualityProfileId: options.qualityProfileId,
        metadataProfileId: options.metadataProfileId,
        rootFolderPath: options.rootFolderPath,
        tags: options.tags ?? [],
        monitored: true,
        addOptions: {
          monitor: 'all',
          searchForMissingAlbums: true,
        },
      });

      return response.data;
    } catch (e) {
      throw new Error(`[Lidarr] Failed to add artist: ${e.message}`, {
        cause: e,
      });
    }
  };
}

export default LidarrAPI;
