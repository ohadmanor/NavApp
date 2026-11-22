package com.navapp.outdoor.israel;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeMapStoreUrlTest {
    @Test
    public void allowlistPermitsOnlyProjectHostsAndRejectsArbitraryOrigins() {
        assertTrue(NativeMapStore.isAllowedRemoteUrl(NativeMapStore.REMOTE_DEM_STORAGE_URL));
        assertTrue(NativeMapStore.isAllowedRemoteUrl(
            "https://storage.googleapis.com/navapp-israel-topo.firebasestorage.app/map_data/Israel.dem.pmtiles"
        ));
        assertTrue(NativeMapStore.isAllowedRemoteUrl(
            "https://navapp-israel-topo-data.web.app/data/Israel.osm.pmtiles"
        ));
        assertTrue(NativeMapStore.isAllowedRemoteUrl(
            "https://navapp-israel-topo.web.app/data/Israel.osm.pmtiles"
        ));

        assertFalse(NativeMapStore.isAllowedRemoteUrl("http://firebasestorage.googleapis.com/v0/b/navapp-israel-topo.firebasestorage.app/o/x"));
        assertFalse(NativeMapStore.isAllowedRemoteUrl("https://evil.example.com/map.pmtiles"));
        assertFalse(NativeMapStore.isAllowedRemoteUrl("https://firebasestorage.googleapis.com/v0/b/other-bucket/o/x"));
        assertFalse(NativeMapStore.isAllowedRemoteUrl("https://user@firebasestorage.googleapis.com/v0/b/navapp-israel-topo.firebasestorage.app/o/x"));
    }

    @Test
    public void resolveAndUnwrapRemoteProxyPreservesEncodedStoragePath() {
        String encoded = "https%3A%2F%2Ffirebasestorage.googleapis.com%2Fv0%2Fb%2Fnavapp-israel-topo.firebasestorage.app%2Fo%2Fmap_data%252FIsrael.dem.pmtiles%3Falt%3Dmedia";
        String proxyUrl = "https://localhost/__remote_proxy__/Israel.dem.pmtiles?url=" + encoded;

        String unwrapped = NativeMapStore.unwrapRemoteProxyUrl(proxyUrl);
        assertEquals(NativeMapStore.REMOTE_DEM_STORAGE_URL, unwrapped);

        assertEquals(
            NativeMapStore.REMOTE_DEM_STORAGE_URL,
            NativeMapStore.resolveAllowedRemoteProxyUrl("Israel.dem.pmtiles", null)
        );
        assertNull(NativeMapStore.unwrapRemoteProxyUrl("https://localhost/__remote_proxy__/Israel.dem.pmtiles?url=https%3A%2F%2Fevil.com%2Fx"));
    }

    @Test
    public void byteRangeParserHandles64BitOffsetsAndStartExtraction() {
        long[] r = NavAppWebViewClient.parseByteRange("bytes=177-870", 1402183369L);
        assertNotNull(r);
        assertEquals(177L, r[0]);
        assertEquals(870L, r[1]);

        long[] large = NavAppWebViewClient.parseByteRange("bytes=3000000000-3000001023", 4000000000L);
        assertNotNull(large);
        assertEquals(3000000000L, large[0]);
        assertEquals(3000001023L, large[1]);

        assertNull(NavAppWebViewClient.parseByteRange("bytes=900-800", 1000L));
        assertEquals(177L, NavAppWebViewClient.parseRangeStartOffset("bytes=177-870"));
        assertEquals(0L, NavAppWebViewClient.parseRangeStartOffset("bytes=-500"));
        assertEquals(0L, NavAppWebViewClient.parseRangeStartOffset(null));
    }
}
