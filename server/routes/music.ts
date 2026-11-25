import FanartTvAPI from '@server/api/fanarttv';
import LidarrAPI from '@server/api/servarr/lidarr';
import { getMusicBrainzAPI } from '@server/api/musicbrainz';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';

/**
 * Music search/discover/request.
 *
 * Seerr's main request pipeline (Media/MediaRequest entities, the
 * approval queue, 4K duplicate handling, etc.) is built entirely around
 * TMDB movie/TV ids, so this intentionally does not try to bolt music onto
 * it. Instead this is the same "direct add" relationship Seerr already has
 * with Radarr/Sonarr at the API level: search MusicBrainz for an artist,
 * then ask the default Lidarr server to look that artist up (matched by
 * MusicBrainz id) and add+monitor it, which makes Lidarr itself go search
 * for and grab the albums. There's no Seerr-side request/approval record
 * for music -- "requested" status is always read live from Lidarr.
 */

const musicRoutes = Router();

function getDefaultLidarr() {
  const settings = getSettings();
  const lidarrSettings =
    settings.lidarr.find((l) => l.isDefault && !l.is4k) ?? settings.lidarr[0];

  if (!lidarrSettings) {
    return undefined;
  }

  return {
    settings: lidarrSettings,
    api: new LidarrAPI({
      apiKey: lidarrSettings.apiKey,
      url: LidarrAPI.buildUrl(lidarrSettings, '/api/v1'),
    }),
  };
}

// A failed or missing Fanart.tv lookup must never take down a search or
// artist page -- it's decoration, not data the rest of the response depends
// on. Every caller gets {} back instead of a rejected promise.
async function lookupArtistImages(
  fanarttv: FanartTvAPI,
  mbid: string
): Promise<{ thumbUrl?: string; backgroundUrl?: string }> {
  try {
    return await fanarttv.getArtistImages(mbid);
  } catch (e) {
    logger.warn('Failed to fetch Fanart.tv images for artist', {
      label: 'Music',
      mbid,
      message: e.message,
    });
    return {};
  }
}

type CombinedMusicResult = {
  mbid: string;
  name: string;
  type?: string;
  disambiguation?: string;
  country?: string;
  beginYear?: string;
  score: number;
  matchType: 'artist' | 'album' | 'song';
  matchTitle?: string;
};

musicRoutes.get('/search', async (req, res, next) => {
  const query = (req.query.query as string | undefined) ?? '';

  try {
    // The shared, process-wide MusicBrainzAPI instance (see
    // getMusicBrainzAPI) so these three calls -- and every other concurrent
    // search -- are actually paced at MusicBrainz's 1-request/second
    // courtesy rate, not just within this one request. That's still only
    // this server's own pacing, not MusicBrainz's -- their side can and
    // does hand back a 503 of its own when it's under load, independent of
    // how politely we ask. allSettled (not all) means one of the three
    // endpoints 503ing degrades that one down to "no results from this
    // endpoint" instead of failing the whole search; each one's rejection
    // is logged just below.
    const musicbrainz = getMusicBrainzAPI();
    const [artistsResult, releaseGroupsResult, recordingsResult] =
      await Promise.allSettled([
        musicbrainz.searchArtists(query),
        musicbrainz.searchReleaseGroups(query),
        musicbrainz.searchRecordings(query),
      ]);
    // allSettled swallows the rejection itself, so log each one here --
    // otherwise a MusicBrainz 503 on, say, recordings would silently vanish
    // into an empty array with no trace in the logs at all.
    const logFailure = (type: string, result: PromiseSettledResult<unknown>) => {
      if (result.status === 'rejected') {
        logger.warn(`Music search: ${type} lookup failed, continuing without it`, {
          label: 'Music',
          message: result.reason?.message ?? result.reason,
        });
      }
    };
    logFailure('artist', artistsResult);
    logFailure('release-group', releaseGroupsResult);
    logFailure('recording', recordingsResult);

    const artists = artistsResult.status === 'fulfilled' ? artistsResult.value : [];
    const releaseGroups =
      releaseGroupsResult.status === 'fulfilled' ? releaseGroupsResult.value : [];
    const recordings =
      recordingsResult.status === 'fulfilled' ? recordingsResult.value : [];

    // Seerr's music feature only ever requests a whole artist to Lidarr
    // (see /request below), so a song or album hit is really just a better
    // way to *find* the right artist -- it still resolves down to one
    // artist-shaped card. Dedupe by artist mbid; a direct artist-name match
    // always wins a collision since it carries richer data (type, country,
    // formation year) than an artist-credit embedded in an album/song hit.
    const byArtistId = new Map<string, CombinedMusicResult>();

    for (const artist of artists) {
      byArtistId.set(artist.id, {
        mbid: artist.id,
        name: artist.name,
        type: artist.type,
        disambiguation: artist.disambiguation,
        country: artist.country,
        beginYear: artist['life-span']?.begin?.slice(0, 4),
        score: artist.score ?? 0,
        matchType: 'artist',
      });
    }

    for (const releaseGroup of releaseGroups) {
      const credit = releaseGroup['artist-credit']?.[0]?.artist;
      if (!credit || byArtistId.has(credit.id)) continue;
      byArtistId.set(credit.id, {
        mbid: credit.id,
        name: credit.name,
        disambiguation: credit.disambiguation,
        score: releaseGroup.score ?? 0,
        matchType: 'album',
        matchTitle: releaseGroup.title,
      });
    }

    for (const recording of recordings) {
      const credit = recording['artist-credit']?.[0]?.artist;
      if (!credit || byArtistId.has(credit.id)) continue;
      byArtistId.set(credit.id, {
        mbid: credit.id,
        name: credit.name,
        disambiguation: credit.disambiguation,
        score: recording.score ?? 0,
        matchType: 'song',
        matchTitle: recording.title,
      });
    }

    // One relevance-sorted list, capped the same as the old artist-only
    // search (20) so the Fanart.tv fan-out below stays bounded no matter
    // how many of the three searches contributed hits.
    const combined = Array.from(byArtistId.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    const fanarttv = new FanartTvAPI();
    const images: { thumbUrl?: string; backgroundUrl?: string }[] =
      fanarttv.hasApiKey
        ? await Promise.all(
            combined.map((result) => lookupArtistImages(fanarttv, result.mbid))
          )
        : combined.map(() => ({}));

    return res.status(200).json({
      results: combined.map((result, i) => ({
        mbid: result.mbid,
        name: result.name,
        type: result.type,
        disambiguation: result.disambiguation,
        country: result.country,
        imageUrl: images[i].thumbUrl,
        beginYear: result.beginYear,
        matchType: result.matchType,
        matchTitle: result.matchTitle,
      })),
    });
  } catch (e) {
    logger.error('Failed to search MusicBrainz', {
      label: 'Music',
      message: e.message,
    });
    next({ status: 500, message: 'Failed to search for artists' });
  }
});

musicRoutes.get<{ mbid: string }>('/artist/:mbid', async (req, res, next) => {
  try {
    const musicbrainz = getMusicBrainzAPI();
    const artist = await musicbrainz.getArtist(req.params.mbid);

    const fanarttv = new FanartTvAPI();
    const images = fanarttv.hasApiKey
      ? await lookupArtistImages(fanarttv, req.params.mbid)
      : {};

    let alreadyAdded = false;
    const lidarr = getDefaultLidarr();
    if (lidarr) {
      try {
        const existing = await lidarr.api.getArtists();
        alreadyAdded = existing.some(
          (a) => a.foreignArtistId === req.params.mbid
        );
      } catch (e) {
        // Don't fail the whole artist page just because the live Lidarr
        // status check failed -- the page still works, it just can't show
        // whether this artist has already been added.
        logger.warn('Failed to check Lidarr for an existing artist', {
          label: 'Music',
          message: e.message,
        });
      }
    }

    return res.status(200).json({
      mbid: artist.id,
      name: artist.name,
      disambiguation: artist.disambiguation,
      type: artist.type,
      country: artist.country,
      imageUrl: images.thumbUrl,
      backgroundUrl: images.backgroundUrl,
      beginYear: artist['life-span']?.begin?.slice(0, 4),
      endYear: artist['life-span']?.ended
        ? artist['life-span']?.end?.slice(0, 4)
        : undefined,
      // MusicBrainz's own community rating, 0-5. Sparse -- most artists have
      // no votes -- but real where it exists, unlike the search row (see
      // getArtist's inc=ratings: only a single-artist lookup can ask for it,
      // never the search endpoint, so this can't be added to /search too).
      rating: artist.rating?.value,
      ratingVotes: artist.rating?.['votes-count'],
      releaseGroups: (artist['release-groups'] ?? [])
        .filter((rg) => rg['primary-type'] === 'Album')
        .sort((a, b) =>
          (b['first-release-date'] ?? '').localeCompare(
            a['first-release-date'] ?? ''
          )
        )
        .map((rg) => ({
          id: rg.id,
          title: rg.title,
          firstReleaseDate: rg['first-release-date'],
        })),
      canRequest: !!lidarr,
      alreadyAdded,
    });
  } catch (e) {
    logger.error('Failed to retrieve MusicBrainz artist', {
      label: 'Music',
      message: e.message,
    });
    next({ status: 500, message: 'Failed to retrieve artist' });
  }
});

musicRoutes.post(
  '/request',
  isAuthenticated(Permission.REQUEST),
  async (req, res, next) => {
    const lidarr = getDefaultLidarr();

    if (!lidarr) {
      return next({
        status: 412,
        message: 'No Lidarr server is configured',
      });
    }

    const { mbid } = req.body as { mbid: string };

    try {
      const lookup = await lidarr.api.lookupArtistByMbid(mbid);

      if (!lookup) {
        return next({
          status: 404,
          message: "Lidarr's metadata provider has no match for this artist",
        });
      }

      if (lookup.id) {
        // Already exists in Lidarr -- nothing to do, just report current state.
        return res.status(200).json({ alreadyAdded: true });
      }

      const metadataProfiles = await lidarr.api.getMetadataProfiles();

      const added = await lidarr.api.addArtist({
        artist: lookup,
        qualityProfileId: lidarr.settings.activeProfileId,
        metadataProfileId: metadataProfiles[0]?.id ?? 1,
        rootFolderPath: lidarr.settings.activeDirectory,
        tags: lidarr.settings.tags,
      });

      logger.info(`Requested artist "${added.artistName}" via Lidarr`, {
        label: 'Music',
        userId: req.user?.id,
      });

      return res.status(201).json({ alreadyAdded: false });
    } catch (e) {
      logger.error('Failed to request artist via Lidarr', {
        label: 'Music',
        message: e.message,
      });
      next({ status: 500, message: 'Failed to add artist to Lidarr' });
    }
  }
);

export default musicRoutes;
