"""Read-only verification of official downloaded Seoul files; no production import."""
import pathlib, zipfile, io, struct, hashlib, json, argparse
import pandas as pd

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source-dir',type=pathlib.Path,default=pathlib.Path(__file__).parent)
ROOT = parser.parse_args().source_dir

def csvzip(name):
    z = zipfile.ZipFile(ROOT/name)
    return pd.read_csv(io.BytesIO(z.read(next(n for n in z.namelist() if n.endswith('.csv')))), encoding='cp949', dtype=str)

def dbfzip(name):
    z = zipfile.ZipFile(ROOT/name)
    b = z.read(next(n for n in z.namelist() if n.endswith('.dbf')))
    count, header, record = struct.unpack_from('<IHH', b, 4)
    fields = []
    for p in range(32, header-1, 32):
        fields.append((b[p:p+11].split(b'\x00')[0].decode('ascii'), b[p+16]))
    rows = []
    for i in range(count):
        start = header+i*record
        if b[start:start+1] == b'*':
            continue
        pos, row = start+1, {}
        for field,length in fields:
            row[field] = b[pos:pos+length].decode('utf-8').strip()
            pos += length
        rows.append(row)
    return pd.DataFrame(rows)

sales = csvzip('sales-2025.zip').rename(columns={'기준_년분기_코드':'quarter','상권_구분_코드':'area_type','상권_코드':'area_code','상권_코드_명':'area_name','서비스_업종_코드':'industry','서비스_업종_코드_명':'industry_name'})
stores = csvzip('stores-2025.zip').rename(columns={'stdr_yyqu_cd':'quarter','trdar_se_cd':'area_type','trdar_cd':'area_code','trdar_cd_nm':'area_name','svc_induty_cd':'industry','svc_induty_cd_nm':'industry_name'})
areas = dbfzip('areas.zip').rename(columns={'TRDAR_SE_C':'area_type','TRDAR_CD':'area_code','TRDAR_CD_N':'area_name'})
keys = ['quarter','area_type','area_code','industry']

def checks(df, keys):
    return {'rows':len(df),'columns':len(df.columns),'duplicates':int(df.duplicated(keys).sum()),'missing_key_rows':int((df[keys].isna() | df[keys].eq('')).any(axis=1).sum()),'unique_areas':int(df.area_code.nunique()),'quarters':sorted(df.quarter.unique().tolist()) if 'quarter' in df else None,'null_cells':int(df.isna().sum().sum())}

report = {'scope':'2025 detailed checks plus 2024-2025 eight-quarter checks; no API authentication, database or application test','datasets':{'sales':checks(sales,keys),'stores':checks(stores,keys),'areas':checks(areas,['area_type','area_code'])}}
joined = sales.merge(stores,on=keys,how='outer',indicator=True,validate='one_to_one',suffixes=('_sales','_stores'))
report['sales_stores_join'] = {str(k):int(v) for k,v in joined['_merge'].value_counts().items()}
both = joined[joined['_merge']=='both']
report['sales_stores_name_mismatch'] = int((both.area_name_sales!=both.area_name_stores).sum())
report['sales_stores_industry_name_mismatch'] = int((both.industry_name_sales!=both.industry_name_stores).sum())
for label,df in [('sales',sales),('stores',stores)]:
    merged = df.merge(areas,on=['area_type','area_code'],how='left',indicator=True,validate='many_to_one',suffixes=('','_area'))
    report[label+'_area_join'] = {str(k):int(v) for k,v in merged['_merge'].value_counts().items()}
    missing = merged[merged['_merge']=='left_only'][['area_type','area_code','area_name']].drop_duplicates()
    report[label+'_unmapped_areas'] = missing.to_dict('records')
    matched=merged[merged['_merge']=='both']
    report[label+'_area_name_mismatch']=int((matched.area_name!=matched.area_name_area).sum())
    report[label+'_area_name_mismatch_examples']=matched[matched.area_name!=matched.area_name_area][['area_code','area_name','area_name_area']].drop_duplicates().to_dict('records')
targetcodes = ['CS100001','CS100002','CS100003','CS100005','CS100010']
report['target_industries'] = []
for industry in targetcodes:
    x=joined[joined.industry==industry]
    report['target_industries'].append({'code':industry,'names':sales[sales.industry==industry].industry_name.unique().tolist(),'join':{str(k):int(v) for k,v in x['_merge'].value_counts().items()},'sales_area_count':int(sales[sales.industry==industry].area_code.nunique())})
sample = both[(both.industry=='CS100010') & both.area_name_sales.str.contains('성수|연남',na=False)]
report['sample_candidates']=sample[['area_code','area_name_sales']].drop_duplicates().to_dict('records')
if len(sample):
    area = sorted(sample.area_code.unique())[0]
    report['sample'] = sample[sample.area_code==area][['quarter','area_type','area_code','area_name_sales','industry','industry_name_sales','당월_매출_금액','stor_co','similr_induty_stor_co','opbiz_stor_co','clsbiz_stor_co','frc_stor_co','opbiz_rt','clsbiz_rt']].sort_values('quarter').to_dict('records')
    report['sample_area_attributes'] = areas[areas.area_code==area].to_dict('records')
report['sales_negative_amounts']=int((pd.to_numeric(sales['당월_매출_금액'])<0).sum())
report['sales_zero_amounts']=int((pd.to_numeric(sales['당월_매출_금액'])==0).sum())
report['manifest']=[{'file':p.name,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(ROOT.glob('*.zip'))]
sales24 = csvzip('sales-2024.zip')
assert sales24.columns.equals(csvzip('sales-2025.zip').columns), 'Sales schema changed between years'
sales24.columns = sales.columns
stores24 = csvzip('stores-2024.zip')
store24_mapping = {'기준_년분기_코드':'quarter','상권_구분_코드':'area_type','상권_구분_코드_명':'trdar_se_cd_nm','상권_코드':'area_code','상권_코드_명':'area_name','서비스_업종_코드':'industry','서비스_업종_코드_명':'industry_name','점포_수':'stor_co','유사_업종_점포_수':'similr_induty_stor_co','개업_율':'opbiz_rt','개업_점포_수':'opbiz_stor_co','폐업_률':'clsbiz_rt','폐업_점포_수':'clsbiz_stor_co','프랜차이즈_점포_수':'frc_stor_co'}
assert set(stores24.columns) == set(store24_mapping), 'Unexpected 2024 stores schema'
stores24 = stores24.rename(columns=store24_mapping)
assert set(stores24.columns) == set(stores.columns)
stores24 = stores24[stores.columns]
all_sales=pd.concat([sales24,sales],ignore_index=True)
all_stores=pd.concat([stores24,stores],ignore_index=True)
all_join=all_sales.merge(all_stores,on=keys,how='outer',indicator=True,validate='one_to_one',suffixes=('_sales','_stores'))
report['eight_quarters']={'sales':checks(all_sales,keys),'stores':checks(all_stores,keys),'join':{str(k):int(v) for k,v in all_join['_merge'].value_counts().items()},'sales24_rows':len(sales24),'stores24_rows':len(stores24)}
report['eight_quarters']['area_join_missing_rows']=int((all_sales.merge(areas,on=['area_type','area_code'],how='left',indicator=True,validate='many_to_one')['_merge']=='left_only').sum())
complete=all_sales[all_sales.industry=='CS100010'].groupby(['area_type','area_code']).quarter.nunique()
report['eight_quarters']['coffee_areas_with_all_8_quarters']=int((complete==8).sum())
report['eight_quarters']['coffee_areas_observed']=len(complete)
report['eight_quarters']['sample']=all_join[(all_join.area_code=='3110127') & (all_join.industry=='CS100010')][['quarter','당월_매출_금액','stor_co','similr_induty_stor_co','opbiz_stor_co','clsbiz_stor_co']].sort_values('quarter').to_dict('records')
report['store_counts_additive_identity_mismatches']=int((pd.to_numeric(all_stores.stor_co)+pd.to_numeric(all_stores.frc_stor_co)!=pd.to_numeric(all_stores.similr_induty_stor_co)).sum())
report['source_downloads']={'endpoint':'https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?useCache=false','method':'POST','form_defaults':{'seqNo':'','infSeq':'3'},'files':{'sales-2024.zip':{'infId':'OA-15572','seq':'50'},'sales-2025.zip':{'infId':'OA-15572','seq':'51'},'stores-2024.zip':{'infId':'OA-15577','seq':'19'},'stores-2025.zip':{'infId':'OA-15577','seq':'20'},'areas.zip':{'infId':'OA-15560','seq':'5'}}}
report['download_date']='2026-09-09'
report['verified_date']='2026-09-10'
(ROOT/'market-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
