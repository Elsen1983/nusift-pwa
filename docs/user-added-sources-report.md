# User-added source inventory

Generated at **2026-07-31T22:31:38.009Z UTC** from the local PostgreSQL database. This is a read-only snapshot; no database data, migrations, or schema objects were changed.

## Scope and interpretation

- Includes every user root/source and category subscription, including inactive entries.
- `isActive=true` is shown as **ACTIVE**; `isActive=false` as **SUSPENDED / INACTIVE**.
- Subscription state is separate from RSS health; RSS status and productivity are shown independently.
- The schema has no exclusive owner field on NewsSource/SourceCategory; a linked source may be shared.
- User-submitted provenance is reported only from stored provenance/submission fields, never inferred.

## Summary

- Users represented: **6**
- Root/source subscriptions: **35** total; **17** active; **18** suspended/inactive.
- Category subscriptions: **14** total; **7** active; **7** suspended/inactive.

### Aggregate root/source health

These counts are for distinct linked `NewsSource` entities referenced by either a root/source or category subscription; they are not subscription-row counts.

| RSS status | Productive | Count |
| --- | --- | --- |
| ACTIVE | no | 7 |
| ACTIVE | yes | 9 |
| NO_RSS_FOUND | no | 7 |
| PENDING_DISCOVERY | no | 13 |

### Aggregate category health

These counts are for distinct `SourceCategory` entities referenced by category subscriptions.

| RSS status | Productive | Count |
| --- | --- | --- |
| ACTIVE | yes | 4 |
| NO_RSS_FOUND | no | 2 |
| NO_RSS_FOUND | yes | 2 |
| PENDING_DISCOVERY | no | 6 |

## User-by-user inventory

### 120225479@umail.ucc.ie

- User ID: `d67e604d-c1cf-479b-83d5-e49aa85a2c7f`
- Role: USER
- Entries: 2 root/source; 0 category

#### Root/source subscriptions

| State | Subscription ID | Media | Source ID | URL | RSS | Productive | RSS URL | Provenance | System | Next retry |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ACTIVE | `9b24a68f-8b5a-4718-9cd0-f2758a7b141c` | Irish Independent | `826772da-09f1-4e97-a515-fb107cc73b5a` | https://www.independent.ie/ | ACTIVE | yes | https://www.independent.ie/rss/ | SYSTEM_DISCOVERED | yes | — |
| ACTIVE | `55d174e1-f451-4722-a83b-3e76d09eabc6` | nlc.hu | `199ad97e-5914-46a0-8474-907e34bdebb6` | https://nlc.hu | ACTIVE | yes | https://nlc.hu/feed/ | SYSTEM_DISCOVERED | no | — |

##### Root/source metadata

| Subscription ID | Source ID | Media type | Detail URL | Submitted by | Submitted at | Nonproductive runs | Subscription created | Subscription updated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `9b24a68f-8b5a-4718-9cd0-f2758a7b141c` | `826772da-09f1-4e97-a515-fb107cc73b5a` | Newspaper | https://www.einpresswire.com/world-media-directory/detail/26984 | — | — | 0 | 2026-06-25T12:54:05.193Z | 2026-06-25T12:54:05.193Z |
| `55d174e1-f451-4722-a83b-3e76d09eabc6` | `199ad97e-5914-46a0-8474-907e34bdebb6` | — | — | — | — | 0 | 2026-06-30T10:49:29.265Z | 2026-06-30T10:49:29.265Z |

#### Category subscriptions

_None._

##### Category metadata

_None._

### ericnorbertkorm@gmail.com

- User ID: `153f0cfd-9471-45f7-b2ba-e90a6dcf692a`
- Role: USER
- Entries: 2 root/source; 0 category

#### Root/source subscriptions

| State | Subscription ID | Media | Source ID | URL | RSS | Productive | RSS URL | Provenance | System | Next retry |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ACTIVE | `7169121a-e3e2-4984-aaf8-6a387057a62e` | corkbeo.ie | `e65430b8-b33c-40bb-be1d-32e3792461ae` | https://www.corkbeo.ie/ | ACTIVE | yes | https://www.corkbeo.ie/?service=rss | SYSTEM_DISCOVERED | no | — |
| ACTIVE | `a13c1387-71f4-40c6-a878-04e1530a9a44` | RTE | `9e7bc55c-2106-4a07-b78f-9cfc8b7e80b1` | https://www.rte.ie | NO_RSS_FOUND | no | — | SYSTEM_DISCOVERED | yes | — |

##### Root/source metadata

| Subscription ID | Source ID | Media type | Detail URL | Submitted by | Submitted at | Nonproductive runs | Subscription created | Subscription updated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `7169121a-e3e2-4984-aaf8-6a387057a62e` | `e65430b8-b33c-40bb-be1d-32e3792461ae` | — | — | — | — | 0 | 2026-07-03T12:32:57.113Z | 2026-07-03T12:32:57.113Z |
| `a13c1387-71f4-40c6-a878-04e1530a9a44` | `9e7bc55c-2106-4a07-b78f-9cfc8b7e80b1` | Broadcast | — | — | — | 54 | 2026-06-08T10:46:45.963Z | 2026-06-08T10:46:45.963Z |

#### Category subscriptions

_None._

##### Category metadata

_None._

### mariahuszar76@gmail.com

- User ID: `f8c0cc2a-d028-4f5e-bafd-190ce98c1feb`
- Role: USER
- Entries: 2 root/source; 2 category

#### Root/source subscriptions

| State | Subscription ID | Media | Source ID | URL | RSS | Productive | RSS URL | Provenance | System | Next retry |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ACTIVE | `c6a240c6-17bb-4efd-92a9-a38cf8924caa` | nlc.hu | `199ad97e-5914-46a0-8474-907e34bdebb6` | https://nlc.hu | ACTIVE | yes | https://nlc.hu/feed/ | SYSTEM_DISCOVERED | no | — |
| ACTIVE | `da6408e7-6643-41c3-9b6d-c447ba59b25e` | nosalty.hu | `40f58531-86e3-489b-8ea6-dd5d29f01ad4` | https://nosalty.hu | NO_RSS_FOUND | no | — | SYSTEM_DISCOVERED | no | — |

##### Root/source metadata

| Subscription ID | Source ID | Media type | Detail URL | Submitted by | Submitted at | Nonproductive runs | Subscription created | Subscription updated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `c6a240c6-17bb-4efd-92a9-a38cf8924caa` | `199ad97e-5914-46a0-8474-907e34bdebb6` | — | — | — | — | 0 | 2026-06-20T21:51:59.217Z | 2026-06-20T21:51:59.217Z |
| `da6408e7-6643-41c3-9b6d-c447ba59b25e` | `40f58531-86e3-489b-8ea6-dd5d29f01ad4` | — | — | — | — | 27 | 2026-07-28T17:24:15.613Z | 2026-07-28T17:24:15.613Z |

#### Category subscriptions

| State | Subscription ID | Media | Category | Path | Category ID | RSS | Productive | RSS URL | User requested |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ACTIVE | `95f898a1-a00e-49f7-82d0-6cfa6f99ba52` | ground.news | interest - science | https://ground.news/interest/science | `4b2a92c9-26b4-48e1-a635-bda0a20b65c8` | NO_RSS_FOUND | no | — | yes |
| ACTIVE | `aea6c304-3d82-4145-a146-197c9924549e` | telex.hu | rovat - eletmod | https://telex.hu/rovat/eletmod | `6001b11f-89e6-49a6-aa17-c9bacc9f313d` | ACTIVE | yes | https://telex.hu/rss/archivum?filters=%7B%22superTagSlugs%22%3A%5B%22eletmod%22%5D%2C%22parentId%22%3A%5B%22null%22%5D%7D&perPage=10 | yes |

##### Category metadata

| Subscription ID | Category ID | Source ID | Source URL | Source RSS | Source productive | Provenance | Submitted by | Submitted at | Nonproductive runs | Next retry | Subscription created | Subscription updated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `95f898a1-a00e-49f7-82d0-6cfa6f99ba52` | `4b2a92c9-26b4-48e1-a635-bda0a20b65c8` | `5cb28e99-2fe5-4115-ae2f-3b54db22bf7e` | https://ground.news | NO_RSS_FOUND | no | SYSTEM_DISCOVERED | — | — | 66 | — | 2026-06-20T23:47:47.611Z | 2026-06-20T23:47:47.611Z |
| `aea6c304-3d82-4145-a146-197c9924549e` | `6001b11f-89e6-49a6-aa17-c9bacc9f313d` | `3fb53832-6007-4a9e-9f30-e236ff50f136` | https://telex.hu | ACTIVE | no | SYSTEM_DISCOVERED | — | — | 0 | — | 2026-07-09T21:52:15.774Z | 2026-07-09T21:52:15.774Z |

### norbert.korom.reg@gmail.com

- User ID: `1b05c561-ba8a-4cb6-ad4e-dda0c54bb8d4`
- Role: USER
- Entries: 6 root/source; 1 category

#### Root/source subscriptions

| State | Subscription ID | Media | Source ID | URL | RSS | Productive | RSS URL | Provenance | System | Next retry |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ACTIVE | `40b2d81b-5e6d-4871-8d88-7149f75207ad` | bbc.com | `a328a1c5-dede-4ca6-8709-22b527863b5c` | https://www.bbc.com | NO_RSS_FOUND | no | — | SYSTEM_DISCOVERED | yes | — |
| SUSPENDED / INACTIVE | `d61ba7c8-16bc-4d1a-bf2e-51d5c594c072` | chiponline.hu | `d89e6b37-b565-40b9-a786-3646e3793fe0` | https://chiponline.hu | PENDING_DISCOVERY | no | — | SYSTEM_DISCOVERED | no | — |
| ACTIVE | `5bb8bd2a-ac60-4002-94ba-970e37bc66b1` | corkbeo.ie | `e65430b8-b33c-40bb-be1d-32e3792461ae` | https://www.corkbeo.ie/ | ACTIVE | yes | https://www.corkbeo.ie/?service=rss | SYSTEM_DISCOVERED | no | — |
| ACTIVE | `2e97cd48-6f64-4257-9b6b-66391fbdf2a5` | gsplus.hu | `4a51cd6d-a8d2-444c-ba0d-059e76de91d2` | https://www.gsplus.hu | ACTIVE | yes | https://www.gsplus.hu/site/rss/rss.xml | SYSTEM_DISCOVERED | no | — |
| ACTIVE | `735eb8f3-6e83-4f20-94c4-25793a7e3127` | Irish Independent | `826772da-09f1-4e97-a515-fb107cc73b5a` | https://www.independent.ie/ | ACTIVE | yes | https://www.independent.ie/rss/ | SYSTEM_DISCOVERED | yes | — |
| ACTIVE | `f90344bb-23b5-41fe-b59a-788fdc2d3dc8` | RTE | `9e7bc55c-2106-4a07-b78f-9cfc8b7e80b1` | https://www.rte.ie | NO_RSS_FOUND | no | — | SYSTEM_DISCOVERED | yes | — |

##### Root/source metadata

| Subscription ID | Source ID | Media type | Detail URL | Submitted by | Submitted at | Nonproductive runs | Subscription created | Subscription updated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `40b2d81b-5e6d-4871-8d88-7149f75207ad` | `a328a1c5-dede-4ca6-8709-22b527863b5c` | Broadcast | — | — | — | 35 | 2026-07-02T12:23:15.948Z | 2026-07-09T08:45:53.996Z |
| `d61ba7c8-16bc-4d1a-bf2e-51d5c594c072` | `d89e6b37-b565-40b9-a786-3646e3793fe0` | — | — | — | — | 0 | 2026-07-02T12:23:16.220Z | 2026-07-10T20:18:24.604Z |
| `5bb8bd2a-ac60-4002-94ba-970e37bc66b1` | `e65430b8-b33c-40bb-be1d-32e3792461ae` | — | — | — | — | 0 | 2026-07-02T12:23:16.129Z | 2026-07-02T12:23:16.129Z |
| `2e97cd48-6f64-4257-9b6b-66391fbdf2a5` | `4a51cd6d-a8d2-444c-ba0d-059e76de91d2` | — | — | — | — | 0 | 2026-07-10T20:18:27.738Z | 2026-07-10T20:18:27.738Z |
| `735eb8f3-6e83-4f20-94c4-25793a7e3127` | `826772da-09f1-4e97-a515-fb107cc73b5a` | Newspaper | https://www.einpresswire.com/world-media-directory/detail/26984 | — | — | 0 | 2026-07-03T10:02:39.266Z | 2026-07-03T10:02:39.266Z |
| `f90344bb-23b5-41fe-b59a-788fdc2d3dc8` | `9e7bc55c-2106-4a07-b78f-9cfc8b7e80b1` | Broadcast | — | — | — | 54 | 2026-07-02T12:23:16.040Z | 2026-07-02T12:23:16.040Z |

#### Category subscriptions

| State | Subscription ID | Media | Category | Path | Category ID | RSS | Productive | RSS URL | User requested |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SUSPENDED / INACTIVE | `6e95dc0c-202f-476d-9a11-845bc6aa890b` | bleacherreport.com | nascar | https://bleacherreport.com/nascar | `5fa1bbd7-f588-456e-baff-d310c07510b8` | PENDING_DISCOVERY | no | — | yes |

##### Category metadata

| Subscription ID | Category ID | Source ID | Source URL | Source RSS | Source productive | Provenance | Submitted by | Submitted at | Nonproductive runs | Next retry | Subscription created | Subscription updated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `6e95dc0c-202f-476d-9a11-845bc6aa890b` | `5fa1bbd7-f588-456e-baff-d310c07510b8` | `1cf3e6ad-6e1b-4b4e-b9a2-bdc58e8f6ed6` | https://bleacherreport.com | ACTIVE | no | SYSTEM_DISCOVERED | — | — | 0 | — | 2026-07-08T20:14:50.506Z | 2026-07-09T08:45:48.851Z |

### norbertkorom@gmail.com

- User ID: `db45d0af-7a57-421c-8241-fb2d7ec30b5e`
- Role: USER
- Entries: 22 root/source; 11 category

#### Root/source subscriptions

| State | Subscription ID | Media | Source ID | URL | RSS | Productive | RSS URL | Provenance | System | Next retry |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ACTIVE | `90004350-769e-417a-81b9-9670ecd5a13a` | 444.hu | `7bab15fd-e451-4e5d-8e7d-171853e66ebe` | https://444.hu | ACTIVE | yes | https://444.hu/feed | SYSTEM_DISCOVERED | no | — |
| ACTIVE | `df6b40a0-f5f5-43da-980d-38005b6e1438` | asiabulletin.com | `cc2c6106-e5bb-4bbd-ba3d-6d7689cb4e7c` | https://www.asiabulletin.com | NO_RSS_FOUND | no | — | SYSTEM_DISCOVERED | no | — |
| SUSPENDED / INACTIVE | `6300b31f-9808-4ffb-b0f6-d58f9df6d3e5` | bbc.com | `a328a1c5-dede-4ca6-8709-22b527863b5c` | https://www.bbc.com | NO_RSS_FOUND | no | — | SYSTEM_DISCOVERED | yes | — |
| SUSPENDED / INACTIVE | `97d958b1-a8d2-4c14-8bea-eba09a4af59d` | corkbeo.ie | `e65430b8-b33c-40bb-be1d-32e3792461ae` | https://www.corkbeo.ie/ | ACTIVE | yes | https://www.corkbeo.ie/?service=rss | SYSTEM_DISCOVERED | no | — |
| SUSPENDED / INACTIVE | `22a9b00d-fc21-428d-8156-0cdb1084658e` | euronews.com | `7f79930e-bd31-4fc1-928a-70405c42fd3b` | https://www.euronews.com | PENDING_DISCOVERY | no | — | SYSTEM_DISCOVERED | no | — |
| SUSPENDED / INACTIVE | `fe8b6daa-e100-4b60-a9e1-9cda3f38771a` | evamagazin.hu | `b8dc500a-ac93-495e-9985-4fe00c9fd4c0` | https://evamagazin.hu | PENDING_DISCOVERY | no | — | SYSTEM_DISCOVERED | no | — |
| SUSPENDED / INACTIVE | `d091cca6-9698-49ed-a00b-3713b9f2bddd` | fitnessfiesta.hu | `a3b891dd-8900-4a7a-9931-f5fe6e8d8c91` | https://fitnessfiesta.hu | PENDING_DISCOVERY | no | — | SYSTEM_DISCOVERED | no | — |
| SUSPENDED / INACTIVE | `99dbc572-100b-4a19-b272-14ebba8cb29e` | fitnesslife.hu | `3b24642c-65d4-4733-8489-8eb8a4970ab4` | https://fitnesslife.hu | PENDING_DISCOVERY | no | — | SYSTEM_DISCOVERED | no | — |
| SUSPENDED / INACTIVE | `f98cc1fd-2004-42d4-b42e-3d0066918db2` | hu.euronews.com | `e0a89123-dd95-4b94-8dc5-af297c7549dd` | https://hu.euronews.com | PENDING_DISCOVERY | no | — | SYSTEM_DISCOVERED | no | — |
| SUSPENDED / INACTIVE | `a92c8367-2959-4e1d-8e4c-809a9debfa20` | joy.hu | `8187bb50-5a64-40b1-810f-f5117feae71b` | https://www.joy.hu | PENDING_DISCOVERY | no | — | SYSTEM_DISCOVERED | no | — |
| SUSPENDED / INACTIVE | `38e627a3-b16b-406b-85d2-13897f968029` | kontroll.hu | `63e333ae-031b-4c74-95d7-568e142e9585` | https://kontroll.hu | PENDING_DISCOVERY | no | — | SYSTEM_DISCOVERED | no | — |
| SUSPENDED / INACTIVE | `5b9b17dc-b5e9-4360-8461-2fa4ce1c543e` | Magyar Nemzet | `568200d9-7975-45df-9616-bebbb9ba7a5a` | https://magyarnemzet.hu | ACTIVE | yes | https://magyarnemzet.hu/publicapi/hu/rss/magyar_nemzet/articles | SYSTEM_DISCOVERED | yes | — |
| SUSPENDED / INACTIVE | `c5407bf2-6fdc-422b-929e-1f15b161fb94` | mediapiac.com | `003e261e-525f-45d0-b187-f909cfdbf2b2` | https://mediapiac.com | PENDING_DISCOVERY | no | — | SYSTEM_DISCOVERED | no | — |
| ACTIVE | `9ebcb958-9a0f-4579-ae05-b79e614a52ca` | nba.com | `71d49c2b-9fcd-4f26-b163-c3318e576b2b` | https://www.nba.com | NO_RSS_FOUND | no | — | SYSTEM_DISCOVERED | no | — |
| SUSPENDED / INACTIVE | `458031c2-5784-43fe-bd15-dcf3a875e5ec` | nemzetisport.hu | `143090d8-9208-43af-8f85-96107f4563cc` | https://nemzetisport.hu | PENDING_DISCOVERY | no | — | SYSTEM_DISCOVERED | no | — |
| SUSPENDED / INACTIVE | `08266d69-3acd-49af-adec-2e631e0c40b9` | Nepszava | `4b7018db-2000-4518-87bb-afd8f8ecfae2` | https://www.nepszava.hu/ | ACTIVE | yes | https://nepszava.hu/rss | SYSTEM_DISCOVERED | yes | — |
| SUSPENDED / INACTIVE | `e42a90f0-530d-4c63-9544-c32a58b95bf7` | nlc.hu | `199ad97e-5914-46a0-8474-907e34bdebb6` | https://nlc.hu | ACTIVE | yes | https://nlc.hu/feed/ | SYSTEM_DISCOVERED | no | — |
| ACTIVE | `ffbf6ffd-ad8e-462f-824a-db7924790f46` | pecaverzum.hu | `2e02b56b-c6ee-492d-a639-9314d02cba22` | https://pecaverzum.hu | ACTIVE | yes | https://pecaverzum.hu/rss | SYSTEM_DISCOVERED | no | — |
| SUSPENDED / INACTIVE | `d880b3ea-5710-46ee-9679-998aa5490fea` | prog.hu | `ac7576a0-d6bb-4ef8-a4f6-72bf5f62de5c` | https://prog.hu | PENDING_DISCOVERY | no | — | SYSTEM_DISCOVERED | no | — |
| ACTIVE | `2e65f002-8ebc-4fe7-a8e4-bee3c47f36ff` | RTE | `9e7bc55c-2106-4a07-b78f-9cfc8b7e80b1` | https://www.rte.ie | NO_RSS_FOUND | no | — | SYSTEM_DISCOVERED | yes | — |
| SUSPENDED / INACTIVE | `1158cce6-035a-4b50-9a47-21fc955ba2e0` | Szabolcs Online | `2f7cc626-814f-485f-a40d-7b7d8d067ac2` | https://www.szon.hu | ACTIVE | no | https://www.szon.hu/publicapi/hu/rss/szon/articles | SYSTEM_DISCOVERED | yes | — |
| SUSPENDED / INACTIVE | `dc58d810-54e5-405c-9b02-3dea81fc95d1` | thesun.ie | `a12aadc5-be36-4246-b0b6-3e5a7c4a709c` | https://www.thesun.ie/ | PENDING_DISCOVERY | no | — | SYSTEM_DISCOVERED | no | — |

##### Root/source metadata

| Subscription ID | Source ID | Media type | Detail URL | Submitted by | Submitted at | Nonproductive runs | Subscription created | Subscription updated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `90004350-769e-417a-81b9-9670ecd5a13a` | `7bab15fd-e451-4e5d-8e7d-171853e66ebe` | — | — | — | — | 0 | 2026-07-07T11:03:35.875Z | 2026-07-29T20:12:38.401Z |
| `df6b40a0-f5f5-43da-980d-38005b6e1438` | `cc2c6106-e5bb-4bbd-ba3d-6d7689cb4e7c` | — | — | — | — | 35 | 2026-07-21T10:40:17.338Z | 2026-07-21T10:40:17.338Z |
| `6300b31f-9808-4ffb-b0f6-d58f9df6d3e5` | `a328a1c5-dede-4ca6-8709-22b527863b5c` | Broadcast | — | — | — | 35 | 2026-06-11T12:29:30.274Z | 2026-07-08T10:22:39.878Z |
| `97d958b1-a8d2-4c14-8bea-eba09a4af59d` | `e65430b8-b33c-40bb-be1d-32e3792461ae` | — | — | — | — | 0 | 2026-06-09T16:21:29.156Z | 2026-07-07T11:04:09.892Z |
| `22a9b00d-fc21-428d-8156-0cdb1084658e` | `7f79930e-bd31-4fc1-928a-70405c42fd3b` | — | — | — | — | 0 | 2026-06-09T09:18:11.587Z | 2026-07-09T11:38:39.066Z |
| `fe8b6daa-e100-4b60-a9e1-9cda3f38771a` | `b8dc500a-ac93-495e-9985-4fe00c9fd4c0` | — | — | — | — | 0 | 2026-07-10T11:46:21.040Z | 2026-07-10T11:50:02.041Z |
| `d091cca6-9698-49ed-a00b-3713b9f2bddd` | `a3b891dd-8900-4a7a-9931-f5fe6e8d8c91` | — | — | — | — | 0 | 2026-07-10T11:55:59.036Z | 2026-07-11T06:41:13.896Z |
| `99dbc572-100b-4a19-b272-14ebba8cb29e` | `3b24642c-65d4-4733-8489-8eb8a4970ab4` | — | — | — | — | 0 | 2026-07-10T11:49:59.893Z | 2026-07-10T11:56:02.978Z |
| `f98cc1fd-2004-42d4-b42e-3d0066918db2` | `e0a89123-dd95-4b94-8dc5-af297c7549dd` | — | — | — | — | 0 | 2026-06-09T09:18:30.141Z | 2026-06-09T09:18:30.141Z |
| `a92c8367-2959-4e1d-8e4c-809a9debfa20` | `8187bb50-5a64-40b1-810f-f5117feae71b` | — | — | — | — | 0 | 2026-07-10T11:30:30.460Z | 2026-07-10T11:46:29.127Z |
| `38e627a3-b16b-406b-85d2-13897f968029` | `63e333ae-031b-4c74-95d7-568e142e9585` | — | — | — | — | 0 | 2026-07-07T11:03:53.532Z | 2026-07-21T10:01:38.771Z |
| `5b9b17dc-b5e9-4360-8461-2fa4ce1c543e` | `568200d9-7975-45df-9616-bebbb9ba7a5a` | Newspaper | — | — | — | 0 | 2026-07-02T16:43:17.366Z | 2026-07-22T08:46:31.539Z |
| `c5407bf2-6fdc-422b-929e-1f15b161fb94` | `003e261e-525f-45d0-b187-f909cfdbf2b2` | — | — | — | — | 0 | 2026-06-04T18:20:39.493Z | 2026-07-07T11:02:32.390Z |
| `9ebcb958-9a0f-4579-ae05-b79e614a52ca` | `71d49c2b-9fcd-4f26-b163-c3318e576b2b` | — | — | — | — | 35 | 2026-07-20T12:17:45.195Z | 2026-07-20T12:17:45.195Z |
| `458031c2-5784-43fe-bd15-dcf3a875e5ec` | `143090d8-9208-43af-8f85-96107f4563cc` | — | — | — | — | 0 | 2026-07-11T19:16:39.076Z | 2026-07-21T10:01:42.541Z |
| `08266d69-3acd-49af-adec-2e631e0c40b9` | `4b7018db-2000-4518-87bb-afd8f8ecfae2` | Newspaper | https://www.einpresswire.com/world-media-directory/detail/26887 | — | — | 0 | 2026-07-01T08:39:19.121Z | 2026-07-11T19:21:38.765Z |
| `e42a90f0-530d-4c63-9544-c32a58b95bf7` | `199ad97e-5914-46a0-8474-907e34bdebb6` | — | — | — | — | 0 | 2026-06-21T00:02:44.345Z | 2026-06-21T00:02:44.345Z |
| `ffbf6ffd-ad8e-462f-824a-db7924790f46` | `2e02b56b-c6ee-492d-a639-9314d02cba22` | — | — | — | — | 0 | 2026-07-23T14:17:03.583Z | 2026-07-23T14:17:03.583Z |
| `d880b3ea-5710-46ee-9679-998aa5490fea` | `ac7576a0-d6bb-4ef8-a4f6-72bf5f62de5c` | — | — | — | — | 0 | 2026-07-11T19:21:47.632Z | 2026-07-22T08:46:36.760Z |
| `2e65f002-8ebc-4fe7-a8e4-bee3c47f36ff` | `9e7bc55c-2106-4a07-b78f-9cfc8b7e80b1` | Broadcast | — | — | — | 54 | 2026-07-07T11:03:00.953Z | 2026-07-09T11:04:20.669Z |
| `1158cce6-035a-4b50-9a47-21fc955ba2e0` | `2f7cc626-814f-485f-a40d-7b7d8d067ac2` | Internet | https://www.einpresswire.com/world-media-directory/detail/26925 | — | — | 0 | 2026-07-02T16:44:08.499Z | 2026-07-06T11:54:09.142Z |
| `dc58d810-54e5-405c-9b02-3dea81fc95d1` | `a12aadc5-be36-4246-b0b6-3e5a7c4a709c` | — | — | — | — | 0 | 2026-06-04T18:02:45.357Z | 2026-07-07T10:50:10.025Z |

#### Category subscriptions

| State | Subscription ID | Media | Category | Path | Category ID | RSS | Productive | RSS URL | User requested |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ACTIVE | `452252fb-49fd-484a-899a-5d7c7d7b6370` | bignewsnetwork.com | category - arizona-news | https://www.bignewsnetwork.com/category/arizona-news | `4c7ca326-6762-40d3-8bc5-4d212f863379` | ACTIVE | yes | https://feeds.bignewsnetwork.com/category/085cec8e58ce1f5a | yes |
| ACTIVE | `3836e78d-b75a-4d21-8b8b-5cea1b671e0b` | bleacherreport.com | nba | https://bleacherreport.com/nba | `ca8d18d9-ad45-4217-9adc-1a5788bbf751` | NO_RSS_FOUND | yes | — | yes |
| SUSPENDED / INACTIVE | `f8a27681-7014-46bc-bd40-2ca091e8fe8b` | Blikk | politika | https://www.blikk.hu/politika | `4b5650b1-3b9f-42eb-a4b5-2afd326f4825` | PENDING_DISCOVERY | no | — | yes |
| SUSPENDED / INACTIVE | `b342a8b9-c96c-4545-8c55-235c0e689abe` | hu.euronews.com | culture - kulturalis-hirek | https://hu.euronews.com/culture/kulturalis-hirek | `73be1d47-0bd2-4c0c-ace7-f3b581861804` | PENDING_DISCOVERY | no | — | yes |
| SUSPENDED / INACTIVE | `6d21520b-059c-4598-b251-ffaed09ee0a3` | Irish Independent | county - cork -  | https://www.independent.ie/county/cork/ | `a281129c-40ab-4d2d-b51b-bb493735da7a` | PENDING_DISCOVERY | no | — | yes |
| ACTIVE | `ca214cb5-47ad-45ff-83c5-843d9826be42` | irishmirror.ie | news - irish-news - crime -  | https://www.irishmirror.ie/news/irish-news/crime/ | `2ae779b5-1d7f-403b-a76d-ee50294cca2a` | NO_RSS_FOUND | yes | — | yes |
| SUSPENDED / INACTIVE | `dfa75c2f-2fc9-4db1-be63-cee5c91e574b` | newstalk.com | news | https://www.newstalk.com/news | `d2ec91fa-9b7c-4052-9b6c-4387c744eb19` | PENDING_DISCOVERY | no | — | yes |
| SUSPENDED / INACTIVE | `993699ff-693e-4dfe-8b1e-8f652661655d` | nyito.mohosz.hu | index.php - hirfolyam | https://nyito.mohosz.hu/index.php/hirfolyam | `b7fc01f3-91b1-4757-a988-8ca0979bdf6b` | ACTIVE | yes | https://nyito.mohosz.hu/index.php/hirfolyam?format=feed&amp;type=rss | yes |
| SUSPENDED / INACTIVE | `971cc4f0-1c90-41f8-8266-2b8867cccb23` | RTE | news - munster -  | https://www.rte.ie/news/munster/ | `0d44b546-bbd1-4af2-a725-09895c2680a5` | PENDING_DISCOVERY | no | — | yes |
| ACTIVE | `43755621-c77a-41bc-9007-0e037fe9288a` | telex.hu | rovat - belfold | https://telex.hu/rovat/belfold | `8fb7cfa1-d479-44b9-9874-07151e2a803e` | ACTIVE | yes | https://telex.hu/rss/archivum?filters=%7B%22superTagSlugs%22%3A%5B%22belfold%22%5D%2C%22parentId%22%3A%5B%22null%22%5D%7D&perPage=10 | yes |
| ACTIVE | `87690ed5-f0d8-453b-99b4-d0cce4911f5b` | Times of India | world - europe | https://timesofindia.indiatimes.com/world/europe | `0beb94bf-c35f-4699-8db8-58b1ad766b97` | NO_RSS_FOUND | no | — | yes |

##### Category metadata

| Subscription ID | Category ID | Source ID | Source URL | Source RSS | Source productive | Provenance | Submitted by | Submitted at | Nonproductive runs | Next retry | Subscription created | Subscription updated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `452252fb-49fd-484a-899a-5d7c7d7b6370` | `4c7ca326-6762-40d3-8bc5-4d212f863379` | `dfadf552-91ee-48e3-aadb-0775184ca832` | https://www.bignewsnetwork.com | NO_RSS_FOUND | no | USER_SUBMITTED | db45d0af-7a57-421c-8241-fb2d7ec30b5e | 2026-07-30T16:21:15.825Z | 0 | — | 2026-06-04T18:02:45.227Z | 2026-07-21T10:01:51.027Z |
| `3836e78d-b75a-4d21-8b8b-5cea1b671e0b` | `ca8d18d9-ad45-4217-9adc-1a5788bbf751` | `1cf3e6ad-6e1b-4b4e-b9a2-bdc58e8f6ed6` | https://bleacherreport.com | ACTIVE | no | SYSTEM_DISCOVERED | — | — | 0 | — | 2026-07-08T19:00:41.245Z | 2026-07-21T10:01:53.074Z |
| `f8a27681-7014-46bc-bd40-2ca091e8fe8b` | `4b5650b1-3b9f-42eb-a4b5-2afd326f4825` | `0b43bb9e-36df-45cf-b847-4106bbf727ac` | https://www.blikk.hu | ACTIVE | no | SYSTEM_DISCOVERED | — | — | 0 | — | 2026-07-06T11:42:50.605Z | 2026-07-09T11:38:26.631Z |
| `b342a8b9-c96c-4545-8c55-235c0e689abe` | `73be1d47-0bd2-4c0c-ace7-f3b581861804` | `e0a89123-dd95-4b94-8dc5-af297c7549dd` | https://hu.euronews.com | PENDING_DISCOVERY | no | SYSTEM_DISCOVERED | — | — | 0 | — | 2026-06-09T09:24:11.807Z | 2026-06-09T09:24:11.807Z |
| `6d21520b-059c-4598-b251-ffaed09ee0a3` | `a281129c-40ab-4d2d-b51b-bb493735da7a` | `826772da-09f1-4e97-a515-fb107cc73b5a` | https://www.independent.ie/ | ACTIVE | yes | SYSTEM_DISCOVERED | — | — | 0 | — | 2026-07-06T10:27:07.847Z | 2026-07-21T10:01:36.709Z |
| `ca214cb5-47ad-45ff-83c5-843d9826be42` | `2ae779b5-1d7f-403b-a76d-ee50294cca2a` | `054aa743-61dc-455e-89cf-c43255569126` | https://irishmirror.ie | ACTIVE | no | SYSTEM_DISCOVERED | — | — | 0 | — | 2026-06-04T18:02:46.371Z | 2026-07-09T11:38:50.639Z |
| `dfa75c2f-2fc9-4db1-be63-cee5c91e574b` | `d2ec91fa-9b7c-4052-9b6c-4387c744eb19` | `8728111d-672d-42b0-8cf0-2b2435eae561` | https://newstalk.com | PENDING_DISCOVERY | no | SYSTEM_DISCOVERED | — | — | 0 | — | 2026-06-04T18:02:45.665Z | 2026-06-11T12:35:55.973Z |
| `993699ff-693e-4dfe-8b1e-8f652661655d` | `b7fc01f3-91b1-4757-a988-8ca0979bdf6b` | `d25d838a-c907-4263-98f2-ab8d9e829dd0` | https://nyito.mohosz.hu | ACTIVE | no | SYSTEM_DISCOVERED | — | — | 0 | — | 2026-07-23T14:17:32.495Z | 2026-07-24T14:33:27.287Z |
| `971cc4f0-1c90-41f8-8266-2b8867cccb23` | `0d44b546-bbd1-4af2-a725-09895c2680a5` | `9e7bc55c-2106-4a07-b78f-9cfc8b7e80b1` | https://www.rte.ie | NO_RSS_FOUND | no | SYSTEM_DISCOVERED | — | — | 0 | — | 2026-07-09T10:24:44.954Z | 2026-07-23T14:17:20.893Z |
| `43755621-c77a-41bc-9007-0e037fe9288a` | `8fb7cfa1-d479-44b9-9874-07151e2a803e` | `3fb53832-6007-4a9e-9f30-e236ff50f136` | https://telex.hu | ACTIVE | no | SYSTEM_DISCOVERED | — | — | 0 | — | 2026-06-09T15:01:17.236Z | 2026-07-09T11:04:26.032Z |
| `87690ed5-f0d8-453b-99b4-d0cce4911f5b` | `0beb94bf-c35f-4699-8db8-58b1ad766b97` | `8776ba6b-4cdb-48ec-bc25-f96fd4167c93` | https://timesofindia.indiatimes.com | ACTIVE | no | SYSTEM_DISCOVERED | — | — | 62 | — | 2026-07-22T08:46:52.187Z | 2026-07-22T08:46:52.187Z |

### rok.mikalauskas@gmail.com

- User ID: `31612e4a-f40b-46cd-b203-f08cbb55b6f7`
- Role: USER
- Entries: 1 root/source; 0 category

#### Root/source subscriptions

| State | Subscription ID | Media | Source ID | URL | RSS | Productive | RSS URL | Provenance | System | Next retry |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ACTIVE | `554a6a05-b38f-497d-b216-543939547fcc` | LRT | `4d52cc04-ec6f-49c7-b23c-59a1895c15ea` | https://www.lrt.lt/ | ACTIVE | yes | https://www.lrt.lt/?rss | SYSTEM_DISCOVERED | yes | — |

##### Root/source metadata

| Subscription ID | Source ID | Media type | Detail URL | Submitted by | Submitted at | Nonproductive runs | Subscription created | Subscription updated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `554a6a05-b38f-497d-b216-543939547fcc` | `4d52cc04-ec6f-49c7-b23c-59a1895c15ea` | Broadcast | https://www.einpresswire.com/world-media-directory/detail/27184 | — | — | 0 | 2026-06-20T20:38:08.648Z | 2026-06-20T20:38:08.648Z |

#### Category subscriptions

_None._

##### Category metadata

_None._

## Limitations

- “Suspended” means inactive user subscription, not an RSS enum. An active subscription can have FAILED, DOMAIN_DEAD, or NO_RSS_FOUND health.
- This is a point-in-time report and can become stale.

## Source URL list

The following is a deduplicated, alphabetically sorted list of all source target URLs shown in the report. RSS feed URLs and technical metadata URLs are intentionally excluded.

1. https://444.hu
2. https://bleacherreport.com/nascar
3. https://bleacherreport.com/nba
4. https://chiponline.hu
5. https://evamagazin.hu
6. https://fitnessfiesta.hu
7. https://fitnesslife.hu
8. https://ground.news/interest/science
9. https://hu.euronews.com
10. https://hu.euronews.com/culture/kulturalis-hirek
11. https://kontroll.hu
12. https://magyarnemzet.hu
13. https://mediapiac.com
14. https://nemzetisport.hu
15. https://nlc.hu
16. https://nosalty.hu
17. https://nyito.mohosz.hu/index.php/hirfolyam
18. https://pecaverzum.hu
19. https://prog.hu
20. https://telex.hu/rovat/belfold
21. https://telex.hu/rovat/eletmod
22. https://timesofindia.indiatimes.com/world/europe
23. https://www.asiabulletin.com
24. https://www.bbc.com
25. https://www.bignewsnetwork.com/category/arizona-news
26. https://www.blikk.hu/politika
27. https://www.corkbeo.ie/
28. https://www.euronews.com
29. https://www.gsplus.hu
30. https://www.independent.ie/
31. https://www.independent.ie/county/cork/
32. https://www.irishmirror.ie/news/irish-news/crime/
33. https://www.joy.hu
34. https://www.lrt.lt/
35. https://www.nba.com
36. https://www.nepszava.hu/
37. https://www.newstalk.com/news
38. https://www.rte.ie
39. https://www.rte.ie/news/munster/
40. https://www.szon.hu
41. https://www.thesun.ie/
