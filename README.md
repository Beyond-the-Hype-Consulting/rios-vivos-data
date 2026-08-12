# Rios Vivos Data

Repositório público de snapshots operacionais usados pelo **Rios Vivos Portugal**, uma iniciativa da BTH — Beyond the Hype.

## Dados publicados

- `public/data/reservoir-status.json`: leituras e histórico recente das albufeiras.
- `public/data/reservoirs.geojson`: catálogo geográfico necessário para validar as correspondências.

Fonte oficial: [APA / SNIRH](https://snirh.apambiente.pt/). Os dados podem conter atrasos, lacunas ou indisponibilidades na origem e não devem ser usados isoladamente para decisão operacional, proteção civil ou emergência.

## Atualização e controlo de qualidade

O workflow `Atualizar dados SNIRH` executa diariamente e também pode ser iniciado manualmente. O snapshot só é publicado quando:

- mantém a identificação da fonte oficial;
- contém uma data de geração válida;
- inclui pelo menos 60 albufeiras com leitura;
- não contém códigos duplicados;
- apresenta identidade e leitura atual em cada registo.

Se a recolha ou a validação falhar, o último snapshot válido permanece disponível.

## Consumo

URL pública estável:

```text
https://raw.githubusercontent.com/Beyond-the-Hype-Consulting/rios-vivos-data/main/public/data/reservoir-status.json
```

© 2026 Beyond the Hype
