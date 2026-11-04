# Publicar o Em dia no GitHub Pages

**Status deste pacote:** código preparado e testes de regras executados. O repositório remoto e o site ainda não foram criados por este pacote.

## 1. Preparar o upload

Extraia o ZIP em uma pasta exclusiva. Você deve ver `index.html`, `assets`, `.nojekyll`, os arquivos de documentação e testes. Não coloque backups ou relatórios pessoais nessa pasta.

## 2. Criar o repositório

No GitHub, escolha **+ → New repository**.

- Proprietário: sua conta, por exemplo `notas-maraba`.
- Nome: `em-dia-relatorios`.
- Descrição: `Checklist de relatórios mensais, cadastro de publicadores e exportação de relatórios. Aplicativo estático com foco em celular.`
- Visibilidade: **Public**, para usar o Pages em uma conta GitHub Free. Repositórios privados exigem um plano compatível. O código estará visível; os cadastros pessoais não fazem parte dele.
- Não inicialize README, `.gitignore` ou licença, pois o pacote já contém os dois primeiros e não define uma licença.

Clique em **Create repository**. Criar o repositório não envia os arquivos automaticamente.

## 3. Enviar os arquivos

No repositório vazio, use **uploading an existing file**. Em um repositório que já tenha arquivos, use **Add file → Upload files**.

Arraste o **conteúdo da pasta descompactada**, incluindo a pasta `assets`, para a tela de upload. Não envie o ZIP e não arraste a pasta externa envolvendo todo o projeto.

Confira antes de confirmar:

```text
index.html
assets/app.css
assets/app.js
assets/core.js
assets/pdf.js
.nojekyll
```

Esses caminhos devem estar na raiz. Os demais arquivos do projeto também podem ser enviados. Use a mensagem de commit `Publicação inicial do Em dia` e confirme em **Commit changes**. Utilize o branch `main`; caso sua conta crie outro nome de branch, selecione esse nome nas configurações do Pages.

## 4. Ativar o Pages

Abra **Settings → Pages → Build and deployment**.

| Campo | Valor |
| --- | --- |
| Source | Deploy from a branch |
| Branch | main, ou o branch em que enviou os arquivos |
| Folder | / (root) |

Clique em **Save**. Não selecione GitHub Actions como fonte personalizada; este pacote usa publicação direta do branch e não precisa de workflow próprio.

Confira a execução de publicação em **Actions**. Quando o GitHub confirmar a publicação, use **Visit site** ou o endereço mostrado em **Settings → Pages**.

Para o proprietário `notas-maraba` e o nome `em-dia-relatorios`, sem domínio personalizado, o endereço esperado é:

```text
https://notas-maraba.github.io/em-dia-relatorios/
```

Esse endereço é apenas o destino previsto; ele não confirma que a publicação já foi realizada.

## 5. Recuperar os dados no site

Antes de sair da versão local, exporte o backup atualizado na aba **Dados**. Depois, abra o site no navegador que será usado, acesse **Dados → Importar backup**, escolha o JSON local e confira os registros.

**O JSON deve ser selecionado dentro do aplicativo, não enviado ao GitHub.** A importação substitui os registros existentes no navegador. Faça backup antes de substituir uma base que já tenha lançamentos.

Teste cadastrar um registro fictício, recarregar e reabrir o site. Teste também a exportação e a restauração de um backup. Não use navegação anônima para os dados definitivos.

## Atualizações futuras

Substitua apenas os arquivos de código no mesmo repositório e branch. A publicação seguirá a fonte configurada. Faça um backup antes de atualizar. Não exclua os dados do navegador nem mude o endereço do sistema sem preparar a migração.

## Problemas comuns

- **Erro 404:** confira o resultado em Actions, a fonte do Pages e se `index.html` está na raiz escolhida.
- **Página sem layout ou funções:** confira se toda a pasta `assets` foi enviada, mantendo nomes e subpastas.
- **Cadastros vazios:** os dados do HTML local não migram sozinhos. Importe o backup dentro do app no navegador definitivo.
- **Dados diferentes no celular e computador:** essa versão não tem sincronização. Cada navegador mantém sua própria base.
- **Erro ao importar:** utilize um backup exportado pelo Em dia; importações são validadas antes da confirmação.

## Referências

Documentação oficial consultada em 4 de novembro de 2026:

- https://docs.github.com/pt/repositories/creating-and-managing-repositories/creating-a-new-repository
- https://docs.github.com/pt/repositories/working-with-files/managing-files/adding-a-file-to-a-repository
- https://docs.github.com/pt/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
