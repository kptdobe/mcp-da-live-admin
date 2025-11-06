import { z } from 'zod';
import { daAdminRequest, formatURL } from '../common/utils.js';

const MEDIA_INDEX_PATH = '/.da/mediaindex/media';

const mediaCache = new Map();

const MediaBaseSchema = z.object({
  org: z.string().describe('The organization'),
  repo: z.string().describe('Name of the repository'),
  path: z.string().optional().describe('Optional path to site folder (for hierarchical org/root/site structures)'),
});

function getGroupingKey(url) {
  if (!url) return '';
  return url.split('?')[0].toLowerCase();
}

function buildMediaPath(path) {
  return path ? `/${path.replace(/^\//, '')}${MEDIA_INDEX_PATH}` : MEDIA_INDEX_PATH;
}

function buildMediaUrl(org, repo, path) {
  return formatURL('source', org, repo, buildMediaPath(path), 'json');
}

function buildErrorResponse(org, repo, path, error) {
  const displayPath = path ? `/${path.replace(/^\//, '')}` : '';
  return {
    error: 'Media index not found',
    initUrl: `https://main--da-live--adobe.aem.live/apps/media-library?nx=media#${org}/${repo}${displayPath}`,
    debug: {
      org,
      repo,
      path,
      url: buildMediaUrl(org, repo, path),
      error: error.message || error.toString(),
    },
  };
}

function buildMediaStructures(rawData) {
  const uniqueItemsMap = new Map();
  const usageIndex = new Map();
  
  rawData.forEach(item => {
    if (!item.url) return;
    
    const groupingKey = getGroupingKey(item.url);
    
    if (!uniqueItemsMap.has(groupingKey)) {
      uniqueItemsMap.set(groupingKey, { ...item, usageCount: 0 });
    }
    uniqueItemsMap.get(groupingKey).usageCount += 1;
    
    if (!usageIndex.has(groupingKey)) {
      usageIndex.set(groupingKey, []);
    }
    usageIndex.get(groupingKey).push({
      doc: item.doc,
      alt: item.alt,
      type: item.type,
      firstUsedAt: item.firstUsedAt,
      lastUsedAt: item.lastUsedAt,
      hash: item.hash,
    });
  });
  
  return {
    uniqueItems: Array.from(uniqueItemsMap.values()),
    usageIndex,
    rawData,
  };
}

async function checkMediaStatus(org, repo, path) {
  try {
    await daAdminRequest(buildMediaUrl(org, repo, path));
    return { initialized: true };
  } catch (error) {
    return { initialized: false, ...buildErrorResponse(org, repo, path, error) };
  }
}

async function getMediaIndex(org, repo, path) {
  const cacheKey = `${org}/${repo}/${path || ''}`;
  const cached = mediaCache.get(cacheKey);
  
  if (cached) {
    return {
      data: cached.uniqueItems,
      total: cached.uniqueItems.length,
      fetchedAt: cached.fetchedAt,
      cached: true,
    };
  }
  
  try {
    const data = await daAdminRequest(buildMediaUrl(org, repo, path));
    const mediaData = data.data || data || [];
    const structures = buildMediaStructures(mediaData);
    const fetchedAt = Date.now();
    
    mediaCache.set(cacheKey, { ...structures, fetchedAt });
    
    return {
      data: structures.uniqueItems,
      total: structures.uniqueItems.length,
      fetchedAt,
      cached: false,
    };
  } catch (error) {
    return buildErrorResponse(org, repo, path, error);
  }
}

async function searchMedia(org, repo, path, filters) {
  const index = await getMediaIndex(org, repo, path);
  
  if (!index.data) {
    return index;
  }
  
  const nameLower = filters.name?.toLowerCase();
  const altLower = filters.alt?.toLowerCase();
  
  const results = index.data.filter(item => {
    if (filters.type && (!item.type || !item.type.includes(filters.type))) {
      return false;
    }
    
    if (filters.doc && item.doc !== filters.doc) {
      return false;
    }
    
    if (nameLower && (!item.name || !item.name.toLowerCase().includes(nameLower))) {
      return false;
    }
    
    if (altLower && (!item.alt || !item.alt.toLowerCase().includes(altLower))) {
      return false;
    }
    
    if (filters.unusedOnly && item.doc && item.doc !== '') {
      return false;
    }
    
    if (filters.missingAlt && item.alt && item.alt !== '' && item.alt !== 'null') {
      return false;
    }
    
    return true;
  });
  
  return {
    results,
    count: results.length,
  };
}

async function getMediaStats(org, repo, path) {
  const index = await getMediaIndex(org, repo, path);
  
  if (!index.data) {
    return index;
  }
  
  const cacheKey = `${org}/${repo}/${path || ''}`;
  const cached = mediaCache.get(cacheKey);
  const rawData = cached ? cached.rawData : index.data;
  
  const typeCount = {};
  let unusedCount = 0;
  const altStatus = {
    filled: 0,
    decorative: 0,
    notFilled: 0,
  };
  
  rawData.forEach(item => {
    const type = item.type || 'unknown';
    typeCount[type] = (typeCount[type] || 0) + 1;
    
    if (!item.doc || item.doc === '') {
      unusedCount++;
    }
    
    if (item.alt === 'null') {
      altStatus.notFilled++;
    } else if (item.alt === '' || !item.alt) {
      altStatus.decorative++;
    } else {
      altStatus.filled++;
    }
  });
  
  return {
    uniqueItems: index.data.length,
    totalReferences: rawData.length,
    byType: typeCount,
    unused: unusedCount,
    altText: altStatus,
  };
}

async function findMediaUsage(org, repo, path, mediaUrl, mediaName) {
  const index = await getMediaIndex(org, repo, path);
  
  if (!index.data) {
    return index;
  }
  
  const cacheKey = `${org}/${repo}/${path || ''}`;
  const cached = mediaCache.get(cacheKey);
  
  if (!cached) {
    return {
      error: 'Media data not loaded',
    };
  }
  
  let groupingKey = null;
  if (mediaUrl) {
    groupingKey = getGroupingKey(mediaUrl);
  } else if (mediaName) {
    const nameLower = mediaName.toLowerCase();
    for (const [key] of cached.usageIndex.entries()) {
      if (key.includes(nameLower)) {
        groupingKey = key;
        break;
      }
    }
  }
  
  if (!groupingKey || !cached.usageIndex.has(groupingKey)) {
    return {
      mediaItem: null,
      usageCount: 0,
      documents: [],
      allUsages: [],
    };
  }
  
  const usages = cached.usageIndex.get(groupingKey);
  const docs = [...new Set(usages.map(item => item.doc).filter(doc => doc))];
  const mediaItem = cached.uniqueItems.find(item => getGroupingKey(item.url) === groupingKey);
  
  return {
    mediaItem,
    usageCount: usages.length,
    documents: docs,
    allUsages: usages,
  };
}

async function refreshMediaCache(org, repo, path) {
  mediaCache.delete(`${org}/${repo}/${path || ''}`);
  return getMediaIndex(org, repo, path);
}

export const tools = [{
  name: "da_media_check_status",
  description: "Check if media index exists on a site. Returns initialization URL if not found.",
  schema: MediaBaseSchema,
  handler: (args) => checkMediaStatus(args.org, args.repo, args.path)
}, {
  name: "da_media_refresh_cache",
  description: "Refresh the media data cache by fetching the latest media.json. Use when media has been updated.",
  schema: MediaBaseSchema,
  handler: (args) => refreshMediaCache(args.org, args.repo, args.path)
}, {
  name: "da_media_get_index",
  description: "Get the complete media index (media.json) for a site. Returns all media references with timestamp.",
  schema: MediaBaseSchema,
  handler: (args) => getMediaIndex(args.org, args.repo, args.path)
}, {
  name: "da_media_search",
  description: "Search and filter media items by type, document, name, alt text, unused status, or missing alt text.",
  schema: MediaBaseSchema.extend({
    type: z.string().optional().describe('Filter by media type (e.g., "png", "img > png")'),
    doc: z.string().optional().describe('Filter by document path'),
    name: z.string().optional().describe('Filter by media name (partial match)'),
    alt: z.string().optional().describe('Filter by alt text content (partial match)'),
    unusedOnly: z.boolean().optional().describe('Show only unused media (no document reference)'),
    missingAlt: z.boolean().optional().describe('Show only images with missing or empty alt text (accessibility check)'),
  }),
  handler: (args) => searchMedia(args.org, args.repo, args.path, {
    type: args.type,
    doc: args.doc,
    name: args.name,
    alt: args.alt,
    unusedOnly: args.unusedOnly,
    missingAlt: args.missingAlt,
  })
}, {
  name: "da_media_get_stats",
  description: "Get media usage statistics including total count, breakdown by type, unused media count, and alt text status (filled/decorative/notFilled).",
  schema: MediaBaseSchema,
  handler: (args) => getMediaStats(args.org, args.repo, args.path)
}, {
  name: "da_media_find_usage",
  description: "Find all documents using a specific media item by URL or name.",
  schema: MediaBaseSchema.extend({
    mediaUrl: z.string().optional().describe('Media URL to search for'),
    mediaName: z.string().optional().describe('Media name to search for'),
  }),
  handler: (args) => findMediaUsage(args.org, args.repo, args.path, args.mediaUrl, args.mediaName)
}];

