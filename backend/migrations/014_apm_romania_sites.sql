-- Romania APM RPC. Apply only after verifying actual deployed table schema and profile entitlement columns.
-- Database migrations define a/b as PostGIS geometry(Geometry,4326), attributes JSONB;
-- user-provided additional layer columns were not present in migration 001.
CREATE INDEX IF NOT EXISTS archaeological_sites_a_geom_geog_gist ON public.archaeological_sites_a USING GIST ((geom::geography));

CREATE OR REPLACE FUNCTION public.apm_sites_within(p_lat double precision,p_lon double precision,p_radius_km double precision DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE lim constant integer:=5000; n integer; payload jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.plan='premium' AND p.premium_expires_at>now()) THEN
   RAISE EXCEPTION 'premium_required' USING ERRCODE='42501';
 END IF;
 IF p_lat NOT BETWEEN -90 AND 90 OR p_lon NOT BETWEEN -180 AND 180 THEN RAISE EXCEPTION 'invalid_coordinates'; END IF;
 WITH q AS MATERIALIZED (
  SELECT object_id, ST_Y(geom::geometry) lat, ST_X(geom::geometry) lon,
   attributes->>'NUMESIT' name, attributes->>'SIRUTA' siruta, attributes->>'COORD' coord_flag
  FROM public.archaeological_sites_a
  WHERE (attributes->>'COORD'='DA' OR (COALESCE(current_setting('apm.include_empty_coord',true),'false')='true' AND NULLIF(attributes->>'COORD','') IS NULL))
   AND ST_DWithin(geom::geography,ST_SetSRID(ST_MakePoint(p_lon,p_lat),4326)::geography,LEAST(GREATEST(p_radius_km,0),50)*1000)
  ORDER BY object_id LIMIT lim+1
 ) SELECT count(*) INTO n FROM q;
 WITH q AS MATERIALIZED (
  SELECT object_id, ST_Y(geom::geometry) lat, ST_X(geom::geometry) lon, attributes->>'NUMESIT' name, attributes->>'SIRUTA' siruta, attributes->>'COORD' coord_flag
  FROM public.archaeological_sites_a WHERE (attributes->>'COORD'='DA' OR (COALESCE(current_setting('apm.include_empty_coord',true),'false')='true' AND NULLIF(attributes->>'COORD','') IS NULL))
   AND ST_DWithin(geom::geography,ST_SetSRID(ST_MakePoint(p_lon,p_lat),4326)::geography,LEAST(GREATEST(p_radius_km,0),50)*1000) ORDER BY object_id LIMIT lim
 ) SELECT jsonb_build_object('rows',COALESCE(jsonb_agg(jsonb_build_object('object_id',object_id,'lat',lat,'lon',lon,'name',name,'siruta',siruta,'coord_flag',coord_flag)),'[]'::jsonb),'truncated',n>lim) INTO payload FROM q;
 RETURN payload;
END $$;
REVOKE ALL ON FUNCTION public.apm_sites_within(double precision,double precision,double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apm_sites_within(double precision,double precision,double precision) TO authenticated;
COMMENT ON FUNCTION public.apm_sites_within IS 'Premium-only, exact-position Romania APM sites. GiST on geometry supports geography ST_DWithin via index-assisted geography cast only if planner can use expression; verify EXPLAIN and consider persisted geography column/index.';
