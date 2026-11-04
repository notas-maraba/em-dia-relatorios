# Em dia — Relatórios mensais

Aplicativo estático em português, com foco em celular, para acompanhar a entrega de relatórios mensais, gerenciar publicadores e períodos de pioneiro, e gerar relatórios mensais e anuais.

**Projeto preparado para GitHub Pages.** Não depende de instalação, servidor de aplicação, banco remoto, compilação ou bibliotecas externas para funcionar. Este pacote não inclui os cadastros e relatórios pessoais.

> Preparar os arquivos não cria o repositório nem ativa o site. Siga [PUBLICAR.md](PUBLICAR.md) para fazer a publicação na sua conta.

## Publicação rápida

1. Crie um repositório chamado `em-dia-relatorios` no GitHub.
2. Envie os arquivos deste pacote descompactado. `index.html` e a pasta `assets` devem estar diretamente na raiz do repositório — não dentro de outra pasta.
3. Em **Settings → Pages**, escolha **Deploy from a branch**, o branch **main** e a pasta **/ (root)**. Salve.
4. Confira o resultado em **Actions** e abra o endereço mostrado pelo próprio Pages.

Use somente o código limpo. Não envie o HTML pessoal, backups JSON, relatórios PDF, planilhas ou imagens com dados de publicadores. O arquivo `.gitignore` ajuda no uso do Git, mas não substitui a revisão do que será enviado manualmente pelo navegador.

## Funcionalidades

### Checklist mensal

Seleção de mês, pesquisa por nome e filtros de pendentes, recebidos, recebidos a conferir e pioneiros. Marcar recebimento não equivale a marcar participação. Relatórios incompletos ficam destacados para conferência; em branco significa não informado e é diferente de zero. A troca de mês não copia entregas nem resultados.

### Publicadores e pioneiros

Cadastro e edição de nomes, período de acompanhamento e observações internas. Pioneiros regulares ou auxiliares podem ter períodos fixos, sem mês final, ou temporários. Períodos não podem se sobrepor. Alterações no cadastro não reescrevem a condição já registrada em relatórios antigos; uma correção histórica deve ser feita no lançamento correspondente.

### Relatórios

Exportação mensal de recebidos, todos ou apenas pendentes. Relatório anual consolidado ou individual, por ano civil ou período setembro–agosto. Download de PDF A4 vertical/horizontal, cópia de texto e compartilhamento nativo quando disponível. Observações internas não aparecem nos relatórios exportados.

A soma anual de estudos é a soma dos valores dos meses, não o número de pessoas diferentes estudando. O mesmo estudo pode estar presente em vários meses. O sistema não estabelece metas de horas nem interpreta regras religiosas.

### Lembretes e dados

Preparação de mensagem individual de cobrança, com registro manual do envio. Não há envio automático de mensagens. Exportação e restauração de backup JSON, configuração de congregação/grupo e exclusão com confirmação. A importação substitui o cadastro atual: faça um backup antes de restaurar outro arquivo.

## Armazenamento e privacidade

A versão publicada começa vazia. Cadastre as pessoas ou importe o backup **dentro do aplicativo**, na aba **Dados**. Importar um arquivo local no app não faz upload desse arquivo ao repositório.

Os registros ficam no `localStorage` do navegador, na chave `em-dia-relatorios-v1`. Não há login, criptografia, sincronização entre aparelhos ou cópia automática na nuvem. Quem tiver acesso ao mesmo perfil do navegador poderá consultar ou alterar os dados. Limpar o armazenamento pode apagar os cadastros; mantenha backups fora do repositório e fora de pastas compartilhadas publicamente.

Ao passar do HTML local para o site publicado, os dados não migram automaticamente: exporte um backup no local antigo e importe no endereço definitivo. Outro aparelho ou perfil terá outra base. Consulte [PRIVACIDADE.md](PRIVACIDADE.md) para os cuidados e limites desta versão.

## Estrutura

```text
index.html                  Entrada do site
assets/
  app.css                   Interface responsiva
  app.js                    Interface, armazenamento e interações
  core.js                   Regras, validações e relatórios
  pdf.js                    Geração local de PDF
.nojekyll                   Publicação estática
.gitignore                  Exclusões para arquivos privados e temporários
.gitattributes              Padronização de fim de linha
package.json                Atalhos opcionais de desenvolvimento
README.md                   Visão geral
PUBLICAR.md                 Passo a passo de publicação
PRIVACIDADE.md               Cuidados com os registros
TESTES.md                    Verificações e limites
tests/core.test.cjs         Testes com dados fictícios
```

Os arquivos necessários ao site são `index.html`, `assets/` e `.nojekyll`. Os demais documentam e testam o projeto. Não existe etapa de build. Todos os caminhos de recursos são relativos, para permitir hospedagem em um endereço de projeto no Pages.

## Desenvolvimento e testes

Para servir localmente com Python instalado:

```sh
python -m http.server 8000
```

Abra `http://localhost:8000`. Esse comando apenas serve a pasta local; não faz publicação remota. Também é possível abrir `index.html` diretamente, mas o armazenamento de arquivos `file:` varia por navegador.

Com Node.js instalado:

```sh
npm test
npm run check
```

Não é necessário executar `npm install`, pois não existem dependências. Os testes também podem ser executados diretamente:

```sh
node tests/core.test.cjs
```

A interface original desta versão foi mantida. Verifique a persistência, restauração de backup e downloads no seu próprio celular antes de adotar o sistema com dados definitivos.

## Documentação técnica

- GitHub Pages: https://docs.github.com/pt/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
- Criação de repositórios: https://docs.github.com/pt/repositories/creating-and-managing-repositories/creating-a-new-repository
- Upload de arquivos: https://docs.github.com/pt/repositories/working-with-files/managing-files/adding-a-file-to-a-repository
- Armazenamento local: https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage
