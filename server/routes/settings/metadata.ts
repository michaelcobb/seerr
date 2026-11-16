import FanartTvAPI from '@server/api/fanarttv';
import TheMovieDb from '@server/api/themoviedb';
import Tvdb from '@server/api/tvdb';
import {
  getSettings,
  MetadataProviderType,
  type MetadataSettings,
} from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';

function getTestResultString(testValue: number): string {
  if (testValue === -1) return 'not tested';
  if (testValue === 0) return 'failed';
  return 'ok';
}

const metadataRoutes = Router();

metadataRoutes.get('/', (_req, res) => {
  const settings = getSettings();
  res.status(200).json({
    tv: settings.metadataSettings.tv,
    anime: settings.metadataSettings.anime,
    fanartTvApiKey: settings.metadataSettings.fanartTvApiKey,
  });
});

metadataRoutes.put('/', async (req, res) => {
  const settings = getSettings();
  const body = req.body as MetadataSettings;

  let tvdbTest = -1;
  let tmdbTest = -1;
  let fanarttvTest = -1;

  try {
    if (
      body.tv === MetadataProviderType.TVDB ||
      body.anime === MetadataProviderType.TVDB
    ) {
      tvdbTest = 0;
      const tvdb = await Tvdb.getInstance();
      await tvdb.test();
      tvdbTest = 1;
    }
  } catch (e) {
    logger.error('Failed to test metadata provider', {
      label: 'Metadata',
      message: e.message,
    });
  }

  try {
    if (
      body.tv === MetadataProviderType.TMDB ||
      body.anime === MetadataProviderType.TMDB
    ) {
      tmdbTest = 0;
      const tmdb = new TheMovieDb();
      await tmdb.getTvShow({ tvId: 1054 });
      tmdbTest = 1;
    }
  } catch (e) {
    logger.error('Failed to test metadata provider', {
      label: 'MetadataProvider',
      message: e.message,
    });
  }

  // Only test the key if one was actually typed in -- an empty key is a
  // valid "I don't want artist images" choice, not a failed test.
  if (body.fanartTvApiKey) {
    try {
      fanarttvTest = 0;
      const fanarttv = new FanartTvAPI(body.fanartTvApiKey);
      await fanarttv.test();
      fanarttvTest = 1;
    } catch (e) {
      logger.error('Failed to test Fanart.tv API key', {
        label: 'Metadata',
        message: e.message,
      });
    }
  }

  // If a test failed, return the test results
  if (tvdbTest === 0 || tmdbTest === 0 || fanarttvTest === 0) {
    return res.status(500).json({
      success: false,
      tests: {
        tvdb: getTestResultString(tvdbTest),
        tmdb: getTestResultString(tmdbTest),
        fanarttv: getTestResultString(fanarttvTest),
      },
    });
  }

  settings.metadataSettings = {
    tv: body.tv,
    anime: body.anime,
    fanartTvApiKey: body.fanartTvApiKey ?? '',
  };
  await settings.save();

  res.status(200).json({
    success: true,
    tv: body.tv,
    anime: body.anime,
    fanartTvApiKey: settings.metadataSettings.fanartTvApiKey,
    tests: {
      tvdb: getTestResultString(tvdbTest),
      tmdb: getTestResultString(tmdbTest),
      fanarttv: getTestResultString(fanarttvTest),
    },
  });
});

metadataRoutes.post('/test', async (req, res) => {
  let tvdbTest = -1;
  let tmdbTest = -1;
  let fanarttvTest = -1;

  try {
    const body = req.body as {
      tmdb: boolean;
      tvdb: boolean;
      fanartTvApiKey?: string;
    };

    try {
      if (body.tmdb) {
        tmdbTest = 0;
        const tmdb = new TheMovieDb();
        await tmdb.getTvShow({ tvId: 1054 });
        tmdbTest = 1;
      }
    } catch (e) {
      logger.error('Failed to test metadata provider', {
        label: 'MetadataProvider',
        message: e.message,
      });
    }

    try {
      if (body.tvdb) {
        tvdbTest = 0;
        const tvdb = await Tvdb.getInstance();
        await tvdb.test();
        tvdbTest = 1;
      }
    } catch (e) {
      logger.error('Failed to test metadata provider', {
        label: 'MetadataProvider',
        message: e.message,
      });
    }

    try {
      if (body.fanartTvApiKey) {
        fanarttvTest = 0;
        const fanarttv = new FanartTvAPI(body.fanartTvApiKey);
        await fanarttv.test();
        fanarttvTest = 1;
      }
    } catch (e) {
      logger.error('Failed to test metadata provider', {
        label: 'MetadataProvider',
        message: e.message,
      });
    }

    const success = !(tvdbTest === 0 || tmdbTest === 0 || fanarttvTest === 0);
    const statusCode = success ? 200 : 500;

    return res.status(statusCode).json({
      success: success,
      tests: {
        tmdb: getTestResultString(tmdbTest),
        tvdb: getTestResultString(tvdbTest),
        fanarttv: getTestResultString(fanarttvTest),
      },
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      tests: {
        tmdb: getTestResultString(tmdbTest),
        tvdb: getTestResultString(tvdbTest),
        fanarttv: getTestResultString(fanarttvTest),
      },
      error: e.message,
    });
  }
});

export default metadataRoutes;
