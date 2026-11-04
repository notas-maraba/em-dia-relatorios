# Verificação do pacote para GitHub Pages

Data: 4 de novembro de 2026.

## Executado neste preparo

- 47 testes automatizados de regras e de geração de PDF aprovados com Node.js 22.16.0, usando dados fictícios.
- Verificação sintática dos três arquivos JavaScript com `node --check`.
- Conferência das referências de scripts e estilos do `index.html`: todos os arquivos existem no pacote e os caminhos são relativos.
- Comparação dos arquivos de execução com a distribuição limpa anterior: interface e lógica mantidas sem alterações.
- Conferência de que não há estado inicial pessoal embutido no HTML.
- Conferência de que nomes dos cadastros do backup pessoal não estão presentes nos arquivos do pacote. O backup foi usado somente como referência de verificação local; não foi incluído no pacote.

Para repetir os testes:

```sh
npm test
npm run check
```

## Escopo e limites

A preparação do pacote não criou repositório nem publicação remota. Não foi realizada uma nova sessão de testes visuais ou de persistência em navegador neste preparo. A aprovação dos testes de lógica não certifica todos os navegadores, aparelhos físicos, diálogos de compartilhamento ou downloads.

Antes do uso definitivo, confira no endereço publicado e no seu próprio dispositivo: salvar e reabrir registros, exportar e restaurar backups, baixar e abrir os PDFs, e navegar nas quatro abas em tela pequena.
